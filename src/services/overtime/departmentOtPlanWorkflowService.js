const { query, transaction } = require('../../config/database');
const AppError = require('../../utils/appError');
const {
  addPlanLog,
  getOvertimePlan,
  normalizeDate,
  normalizePeriodType,
  validatePlanPeriod,
} = require('./overtimePlanService');
const { getEmployeeByUserId } = require('./employeeService');
const { createActualPeriodFromApprovedPlan } = require('./actualOvertimeService');
const { createSignatureSignedUrl, getUserSignature } = require('../signatureService');
const {
  buildFullName,
  dateOnly,
  iso,
  makeId,
  normalize,
  nullable,
  toNumber,
} = require('./shared/utils');

const APPROVAL_ROLES = ['supervisor', 'japanese_management', 'hr', 'admin'];
const ROUTE_STATUSES = ['active', 'inactive'];
const BLOCKING_EMPLOYEE_PLAN_STATUSES = [
  'submitted',
  'submitted_to_supervisor',
  'supervisor_returned',
  'supervisor_accepted',
  'pending_approval',
  'returned_for_revision',
  'approved',
  'closed',
];

const RESETTABLE_PLAN_STATUSES = ['draft', 'supervisor_returned', 'returned_for_revision'];
const SUPERVISOR_PROTECTED_PLAN_STATUSES = ['approved', 'closed'];
const MAX_SUPERVISOR_BULK_ITEMS = 500;

function normalizeResetStatus(status, planScope) {
  const normalized = normalize(status || 'draft').toLowerCase();

  if (!RESETTABLE_PLAN_STATUSES.includes(normalized)) {
    throw new AppError('Reset status must be draft, supervisor_returned, or returned_for_revision.', 400, 'INVALID_RESET_STATUS');
  }

  const scope = normalize(planScope || 'employee').toLowerCase();

  if (scope === 'employee' && normalized === 'returned_for_revision') {
    throw new AppError('Employee OT plans can only be reset to draft or supervisor_returned.', 400, 'INVALID_EMPLOYEE_RESET_STATUS');
  }

  if (scope === 'department' && normalized === 'supervisor_returned') {
    throw new AppError('Department OT plans can only be reset to draft or returned_for_revision.', 400, 'INVALID_DEPARTMENT_RESET_STATUS');
  }

  return normalized;
}

function buildResetRemarks(oldStatus, newStatus, remarks) {
  return `Status reset from ${oldStatus} to ${newStatus}. Reason: ${normalize(remarks)}`;
}

function normalizeBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return ['true', '1', 'yes', 'y'].includes(String(value).trim().toLowerCase());
}

function normalizeSupervisorBulkItems(items, plan) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError('Select at least one employee overtime entry.', 400, 'PLAN_ITEMS_REQUIRED');
  }

  if (items.length > MAX_SUPERVISOR_BULK_ITEMS) {
    throw new AppError(
      `A maximum of ${MAX_SUPERVISOR_BULK_ITEMS} employee overtime entries can be saved at a time.`,
      400,
      'PLAN_ITEMS_LIMIT_EXCEEDED'
    );
  }

  const seenEmployeeDates = new Set();

  return items.map((item) => {
    const employeeId = normalize(item.employeeId);
    const plannedDate = normalizeDate(item.plannedDate ?? item.date, 'plannedDate');
    const plannedHours = Number(item.plannedHours ?? item.totalHours);

    if (!employeeId) {
      throw new AppError('Employee ID is required for every overtime entry.', 400, 'PLAN_ITEM_EMPLOYEE_REQUIRED');
    }

    if (!Number.isFinite(plannedHours) || plannedHours <= 0 || plannedHours > 9999.99) {
      throw new AppError(
        'Planned hours must be greater than zero and no more than 9999.99.',
        400,
        'INVALID_PLANNED_HOURS'
      );
    }

    if (plannedDate < plan.periodStartDate || plannedDate > plan.periodEndDate) {
      throw new AppError(
        'Every planned date must be within the overtime plan period.',
        400,
        'PLAN_ITEM_DATE_OUT_OF_RANGE'
      );
    }

    const uniqueKey = `${employeeId}|${plannedDate}`;

    if (seenEmployeeDates.has(uniqueKey)) {
      throw new AppError(
        'Duplicate employee/date found in the submitted overtime entries.',
        409,
        'DUPLICATE_PLAN_ITEM_IN_REQUEST'
      );
    }

    seenEmployeeDates.add(uniqueKey);
    return {
      planItemId: makeId('PLANITEM'),
      employeeId,
      plannedDate,
      plannedHours: Math.round(plannedHours * 100) / 100,
    };
  });
}

async function ensureSupervisorBulkEmployeesAreInScope(items, departmentId, supervisorUserId, executor) {
  const employeeIds = [...new Set(items.map((item) => item.employeeId))];
  const result = await executor.query(
    `
      SELECT e.employee_id
      FROM employees e
      INNER JOIN users u ON u.id = e.user_id
      WHERE e.employee_id = ANY($1::TEXT[])
        AND e.department_id = $2
        AND e.supervisor_user_id = $3
        AND e.status = 'active'
        AND u.status = 'active';
    `,
    [employeeIds, departmentId, supervisorUserId]
  );
  const allowedEmployeeIds = new Set(result.rows.map((row) => row.employee_id));
  const outOfScopeEmployeeIds = employeeIds.filter((employeeId) => !allowedEmployeeIds.has(employeeId));

  if (outOfScopeEmployeeIds.length > 0) {
    throw new AppError(
      'Every employee must be active and assigned to the requesting supervisor in the same department.',
      403,
      'SUPERVISOR_PLAN_EMPLOYEE_OUT_OF_SCOPE'
    );
  }
}

async function insertSupervisorBulkItems(planId, items, executor) {
  await executor.query(
    `
      INSERT INTO overtime_plan_items (
        plan_item_id,
        plan_id,
        employee_id,
        planned_date,
        planned_hours,
        reason
      )
      SELECT
        bulk_item.plan_item_id,
        $1,
        bulk_item.employee_id,
        bulk_item.planned_date,
        bulk_item.planned_hours,
        ''
      FROM JSONB_TO_RECORDSET($2::JSONB) AS bulk_item(
        plan_item_id TEXT,
        employee_id TEXT,
        planned_date DATE,
        planned_hours NUMERIC
      );
    `,
    [
      planId,
      JSON.stringify(items.map((item) => ({
        plan_item_id: item.planItemId,
        employee_id: item.employeeId,
        planned_date: item.plannedDate,
        planned_hours: item.plannedHours,
      }))),
    ]
  );
}

async function lockDepartmentPlanPeriod(plan, executor) {
  const lockKey = [
    'department-plan-create',
    plan.departmentId,
    plan.periodType,
    plan.periodStartDate,
    plan.periodEndDate,
  ].join(':');

  await executor.query('SELECT pg_advisory_xact_lock(hashtext($1)::BIGINT);', [lockKey]);
}

async function ensureDepartmentPlanPeriodIsAvailable(plan, executor) {
  const result = await executor.query(
    `
      SELECT plan_id
      FROM overtime_plans
      WHERE department_id = $1
        AND COALESCE(plan_scope, 'employee') = 'department'
        AND period_type = $2
        AND period_start_date = $3
        AND period_end_date = $4
      LIMIT 1;
    `,
    [plan.departmentId, plan.periodType, plan.periodStartDate, plan.periodEndDate]
  );

  if (result.rows.length > 0) {
    throw new AppError(
      'A Department OT Plan already exists for this period.',
      409,
      'DEPARTMENT_PLAN_ALREADY_EXISTS'
    );
  }
}

async function createSupervisorDepartmentPlanDraft(planData, createdBy) {
  const plan = {
    departmentId: normalize(planData.departmentId),
    supervisorUserId: normalize(planData.supervisorUserId),
    periodType: normalizePeriodType(planData.periodType || 'weekly'),
    periodStartDate: normalizeDate(planData.periodStartDate, 'periodStartDate'),
    periodEndDate: normalizeDate(planData.periodEndDate, 'periodEndDate'),
  };
  validatePlanPeriod(plan.periodType, plan.periodStartDate, plan.periodEndDate);

  if (!plan.departmentId || !plan.supervisorUserId) {
    throw new AppError(
      'A linked supervisor and department are required.',
      403,
      'SUPERVISOR_DEPARTMENT_REQUIRED'
    );
  }

  const items = normalizeSupervisorBulkItems(planData.items, plan);

  return transaction(async (client) => {
    await lockDepartmentPlanPeriod(plan, client);
    await ensureDepartmentPlanPeriodIsAvailable(plan, client);
    await ensureSupervisorBulkEmployeesAreInScope(
      items,
      plan.departmentId,
      plan.supervisorUserId,
      client
    );

    const planId = makeId('DEPTPLAN');
    await client.query(
      `
        INSERT INTO overtime_plans (
          plan_id,
          department_id,
          period_type,
          period_start_date,
          period_end_date,
          status,
          plan_scope,
          employee_signatures_required,
          created_by,
          remarks
        )
        VALUES ($1, $2, $3, $4, $5, 'draft', 'department', FALSE, $6, $7);
      `,
      [
        planId,
        plan.departmentId,
        plan.periodType,
        plan.periodStartDate,
        plan.periodEndDate,
        normalize(createdBy),
        nullable(planData.remarks),
      ]
    );
    await insertSupervisorBulkItems(planId, items, client);
    await addPlanLog(
      planId,
      'supervisor_bulk_department_draft_created',
      createdBy,
      `Supervisor-created department draft saved with ${items.length} overtime entr${items.length === 1 ? 'y' : 'ies'}.`,
      client
    );

    return getOvertimePlan(planId, {}, client);
  });
}

async function replaceSupervisorDepartmentPlanDraft(planId, draftData, supervisorUserId) {
  return transaction(async (client) => {
    const lockResult = await client.query(
      'SELECT updated_at FROM overtime_plans WHERE plan_id = $1 FOR UPDATE;',
      [normalize(planId)]
    );

    if (lockResult.rows.length === 0) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    const expectedUpdatedAt = normalize(draftData.expectedUpdatedAt);

    if (!expectedUpdatedAt || Number.isNaN(new Date(expectedUpdatedAt).getTime())) {
      throw new AppError(
        'expectedUpdatedAt must contain the department plan version being edited.',
        400,
        'PLAN_VERSION_REQUIRED'
      );
    }

    const currentUpdatedAt = new Date(lockResult.rows[0].updated_at).toISOString();

    if (new Date(expectedUpdatedAt).toISOString() !== currentUpdatedAt) {
      throw new AppError(
        'This department plan changed after you opened it. Reload before saving.',
        409,
        'PLAN_VERSION_CONFLICT'
      );
    }

    const existingPlan = await getOvertimePlan(planId, {}, client);

    if ((existingPlan.planScope || 'employee') !== 'department') {
      throw new AppError(
        'Only department overtime drafts can be replaced through this endpoint.',
        400,
        'PLAN_SCOPE_NOT_DEPARTMENT'
      );
    }

    if (!['draft', 'returned_for_revision'].includes(existingPlan.status)) {
      throw new AppError(
        'Only draft or returned department plans can be edited.',
        400,
        'PLAN_NOT_EDITABLE'
      );
    }

    const items = normalizeSupervisorBulkItems(draftData.items, existingPlan);
    await ensureSupervisorBulkEmployeesAreInScope(
      items,
      existingPlan.departmentId,
      supervisorUserId,
      client
    );

    await client.query('DELETE FROM overtime_plan_items WHERE plan_id = $1;', [existingPlan.planId]);
    await insertSupervisorBulkItems(existingPlan.planId, items, client);
    await client.query(
      `
        UPDATE overtime_plans
        SET remarks = $2,
            updated_at = NOW()
        WHERE plan_id = $1;
      `,
      [existingPlan.planId, nullable(draftData.remarks)]
    );
    await addPlanLog(
      existingPlan.planId,
      'supervisor_bulk_department_draft_saved',
      supervisorUserId,
      `Supervisor-created department draft saved with ${items.length} overtime entr${items.length === 1 ? 'y' : 'ies'}.`,
      client
    );

    return getOvertimePlan(existingPlan.planId, {}, client);
  });
}

function normalizeApprovalRole(role) {
  const normalized = normalize(role).toLowerCase().replace(/-/g, '_');

  if (['hr', 'admin', 'hr_admin', 'hradmin', 'final_approver', 'final_approval'].includes(normalized)) {
    // HR and Admin are treated as one final approval group.
    // Keep the stored DB role as 'hr' so no Supabase table/constraint change is needed.
    return 'hr';
  }

  if (!APPROVAL_ROLES.includes(normalized)) {
    throw new AppError('Approval role must be supervisor, japanese_management, hr_admin, hr, or admin.', 400, 'INVALID_APPROVAL_ROLE');
  }

  return normalized;
}

function isFinalApprovalRole(role) {
  const normalized = normalize(role).toLowerCase().replace(/-/g, '_');
  return ['hr', 'admin', 'hr_admin', 'hradmin', 'final_approver', 'final_approval'].includes(normalized);
}

function normalizeRouteStatus(status) {
  const normalized = normalize(status || 'active').toLowerCase();

  if (!ROUTE_STATUSES.includes(normalized)) {
    throw new AppError('Approval route status must be active or inactive.', 400, 'INVALID_APPROVAL_ROUTE_STATUS');
  }

  return normalized;
}

function mapApprovalRoute(row) {
  return {
    routeId: row.route_id,
    departmentId: row.department_id,
    departmentName: row.department_name || '',
    routeName: row.route_name,
    status: row.status,
    createdBy: row.created_by || '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapAssignedApprover(row) {
  const approverName = buildFullName({
    firstName: row.approver_first_name,
    middleName: row.approver_middle_name,
    lastName: row.approver_last_name,
  });

  return {
    assignmentId: row.step_id,
    routeId: row.route_id,
    approverRole: row.approver_role,
    approverUserId: row.approver_user_id || '',
    approverName,
    approvalLabel: row.step_name,
    createdAt: iso(row.created_at),
  };
}

function mapApprovalStep(row) {
  const assignedApprover = mapAssignedApprover(row);

  return {
    stepId: assignedApprover.assignmentId,
    routeId: assignedApprover.routeId,
    stepOrder: toNumber(row.step_order),
    stepName: assignedApprover.approvalLabel,
    approverRole: assignedApprover.approverRole,
    approverUserId: assignedApprover.approverUserId,
    approverName: assignedApprover.approverName,
    createdAt: assignedApprover.createdAt,
  };
}

function mapPlanApproval(row) {
  const actedByName = buildFullName({
    firstName: row.acted_by_first_name,
    middleName: row.acted_by_middle_name,
    lastName: row.acted_by_last_name,
  });

  return {
    approvalId: row.approval_id,
    planId: row.plan_id,
    routeId: row.route_id || '',
    stepId: row.step_id || '',
    stepOrder: toNumber(row.step_order),
    stepName: row.step_name,
    approverRole: row.approver_role,
    approverUserId: row.approver_user_id || '',
    status: row.status,
    actedBy: row.acted_by || '',
    actedByName,
    actedAt: iso(row.acted_at),
    signatureFilePath: row.signature_file_path || '',
    signatureMimeType: row.signature_mime_type || '',
    remarks: row.remarks || '',
    createdAt: iso(row.created_at),
    departmentId: row.department_id || '',
    departmentName: row.department_name || '',
    periodType: row.period_type || '',
    periodStartDate: dateOnly(row.period_start_date),
    periodEndDate: dateOnly(row.period_end_date),
    planStatus: row.plan_status || row.status || '',
    planScope: row.plan_scope || '',
  };
}

const routeSelect = `
  SELECT
    r.*,
    d.department_name
  FROM overtime_plan_approval_routes r
  INNER JOIN departments d ON d.department_id = r.department_id
`;

const stepSelect = `
  SELECT
    s.*,
    u.first_name AS approver_first_name,
    u.middle_name AS approver_middle_name,
    u.last_name AS approver_last_name
  FROM overtime_plan_approval_route_steps s
  LEFT JOIN users u ON u.id = s.approver_user_id
`;

const approvalSelect = `
  SELECT
    a.*,
    u.first_name AS acted_by_first_name,
    u.middle_name AS acted_by_middle_name,
    u.last_name AS acted_by_last_name
  FROM overtime_plan_approvals a
  LEFT JOIN users u ON u.id = a.acted_by
`;

async function getApprovalRoutes(filters = {}) {
  const clauses = [];
  const params = [];

  if (filters.departmentId) {
    params.push(normalize(filters.departmentId));
    clauses.push(`r.department_id = $${params.length}`);
  }

  if (filters.status) {
    params.push(normalizeRouteStatus(filters.status));
    clauses.push(`r.status = $${params.length}`);
  }

  const result = await query(
    `
      ${routeSelect}
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY d.department_name ASC, r.status ASC, r.created_at DESC;
    `,
    params
  );

  return result.rows.map(mapApprovalRoute);
}

async function getApprovalRoute(routeId, executor = { query }) {
  const routeResult = await executor.query(
    `
      ${routeSelect}
      WHERE r.route_id = $1
      LIMIT 1;
    `,
    [normalize(routeId)]
  );

  if (routeResult.rows.length === 0) {
    return null;
  }

  const assignmentsResult = await executor.query(
    `
      ${stepSelect}
      WHERE s.route_id = $1
      ORDER BY s.step_order ASC, s.created_at ASC;
    `,
    [normalize(routeId)]
  );

  return {
    ...mapApprovalRoute(routeResult.rows[0]),
    assignedApprovers: assignmentsResult.rows.map(mapAssignedApprover),
  };
}

async function getActiveApprovalRouteForDepartment(departmentId, executor = { query }) {
  const result = await executor.query(
    `
      SELECT route_id
      FROM overtime_plan_approval_routes
      WHERE department_id = $1
        AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1;
    `,
    [normalize(departmentId)]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return getApprovalRoute(result.rows[0].route_id, executor);
}

function createApprovalLabel(approverRole) {
  const labels = {
    supervisor: 'Assigned Supervisor Approval',
    japanese_management: 'Assigned Japanese Management Approval',
    hr: 'Assigned HR/Admin Final Approval',
    admin: 'Assigned HR/Admin Final Approval',
  };

  return labels[approverRole] || 'Assigned Approval';
}

function addAssignedApproverCandidate(assignments, approverRole, approverUserId) {
  const normalizedUserId = normalize(approverUserId);

  if (!normalizedUserId) {
    return;
  }

  const normalizedRole = normalizeApprovalRole(approverRole);
  const key = `${normalizedRole}|${normalizedUserId}`;

  if (assignments.some((item) => item.key === key)) {
    return;
  }

  assignments.push({
    key,
    approverRole: normalizedRole,
    approverUserId: normalizedUserId,
    approvalLabel: createApprovalLabel(normalizedRole),
  });
}

function normalizeApprovalRouteAssignments(routeData) {
  const assignments = [];
  const rawAssignedApprovers = Array.isArray(routeData.assignedApprovers)
    ? routeData.assignedApprovers
    : Array.isArray(routeData.approvers)
      ? routeData.approvers
      : [];

  for (const approver of rawAssignedApprovers) {
    addAssignedApproverCandidate(
      assignments,
      approver.approverRole || approver.role,
      approver.approverUserId || approver.userId
    );
  }

  addAssignedApproverCandidate(
    assignments,
    'supervisor',
    routeData.supervisorApproverUserId || routeData.supervisorUserId
  );

  const japaneseManagementIds = routeData.japaneseManagementApproverUserIds
    || routeData.japaneseManagementUserIds
    || routeData.japaneseManagementApprovers
    || [];

  for (const userId of Array.isArray(japaneseManagementIds) ? japaneseManagementIds : [japaneseManagementIds]) {
    addAssignedApproverCandidate(assignments, 'japanese_management', userId);
  }

  const hrIds = routeData.hrApproverUserIds || routeData.hrUserIds || routeData.hrApprovers || [];
  for (const userId of Array.isArray(hrIds) ? hrIds : [hrIds]) {
    addAssignedApproverCandidate(assignments, 'hr', userId);
  }

  addAssignedApproverCandidate(assignments, 'hr', routeData.hrApproverUserId || routeData.hrUserId);

  const adminIds = routeData.adminApproverUserIds || routeData.adminUserIds || routeData.adminApprovers || [];
  for (const userId of Array.isArray(adminIds) ? adminIds : [adminIds]) {
    addAssignedApproverCandidate(assignments, 'admin', userId);
  }

  addAssignedApproverCandidate(assignments, 'admin', routeData.adminApproverUserId || routeData.adminUserId);

  // Backward compatibility only: if an old client still sends steps, treat them as assigned approvers.
  const legacySteps = Array.isArray(routeData.steps) ? routeData.steps : [];
  for (const step of legacySteps) {
    addAssignedApproverCandidate(
      assignments,
      step.approverRole || step.role,
      step.approverUserId || step.userId
    );
  }

  const hasSupervisor = assignments.some((item) => item.approverRole === 'supervisor');
  const hasFinalApprover = assignments.some((item) => isFinalApprovalRole(item.approverRole));

  if (!hasSupervisor) {
    throw new AppError('Assign one supervisor approver for this department.', 400, 'SUPERVISOR_APPROVER_REQUIRED');
  }

  // HR/Admin is one final approval group. If the client does not provide a specific
  // HR/Admin user, create a generic final approval assignment that any HR/Admin can complete.
  if (!hasFinalApprover) {
    assignments.push({
      key: 'hr|',
      approverRole: 'hr',
      approverUserId: '',
      approvalLabel: createApprovalLabel('hr'),
    });
  }

  return assignments.map(({ key, ...assignment }) => assignment);
}

async function validateAssignedApprover(assignment, executor = { query }) {
  const approverRole = normalizeApprovalRole(assignment.approverRole);
  const approverUserId = normalize(assignment.approverUserId);

  if (!approverUserId) {
    if (isFinalApprovalRole(approverRole)) {
      return {
        approverRole: 'hr',
        approverUserId: '',
        approvalLabel: assignment.approvalLabel || createApprovalLabel('hr'),
      };
    }

    throw new AppError('Assigned approver user ID is required.', 400, 'APPROVER_USER_ID_REQUIRED');
  }

  const userResult = await executor.query('SELECT id, role, status FROM users WHERE id = $1 LIMIT 1;', [approverUserId]);

  if (userResult.rows.length === 0) {
    throw new AppError('Approver user not found.', 404, 'APPROVER_USER_NOT_FOUND');
  }

  const approver = userResult.rows[0];

  if (approver.status !== 'active') {
    throw new AppError('Assigned approver account must be active.', 400, 'APPROVER_NOT_ACTIVE');
  }

  const validRoleByAssignment = {
    supervisor: ['supervisor'],
    japanese_management: ['japanese_management'],
    hr: ['hr', 'admin'],
    admin: ['hr', 'admin'],
  };

  if (!validRoleByAssignment[approverRole].includes(approver.role)) {
    throw new AppError(
      `Assigned approver must have ${isFinalApprovalRole(approverRole) ? 'HR or Admin' : approverRole} role.`,
      400,
      'APPROVER_ROLE_MISMATCH'
    );
  }

  return {
    approverRole: isFinalApprovalRole(approverRole) ? 'hr' : approverRole,
    approverUserId,
    approvalLabel: assignment.approvalLabel || createApprovalLabel(approverRole),
  };
}

async function createApprovalRoute(routeData, createdBy) {
  const departmentId = normalize(routeData.departmentId);
  const routeName = normalize(routeData.routeName || routeData.name);
  const status = normalizeRouteStatus(routeData.status || 'active');
  const assignedApprovers = normalizeApprovalRouteAssignments(routeData);

  if (!departmentId || !routeName) {
    throw new AppError('Department ID and route name are required.', 400, 'APPROVAL_ROUTE_REQUIRED_FIELDS');
  }

  return transaction(async (client) => {
    const department = await client.query('SELECT department_id FROM departments WHERE department_id = $1 LIMIT 1;', [departmentId]);

    if (department.rows.length === 0) {
      throw new AppError('Department not found.', 404, 'DEPARTMENT_NOT_FOUND');
    }

    if (status === 'active') {
      await client.query(
        `UPDATE overtime_plan_approval_routes SET status = 'inactive', updated_at = NOW() WHERE department_id = $1;`,
        [departmentId]
      );
    }

    const routeId = makeId('OTROUTE');
    await client.query(
      `
        INSERT INTO overtime_plan_approval_routes (route_id, department_id, route_name, status, created_by)
        VALUES ($1, $2, $3, $4, $5);
      `,
      [routeId, departmentId, routeName, status, normalize(createdBy)]
    );

    for (let index = 0; index < assignedApprovers.length; index += 1) {
      await addApprovalRouteAssignment(routeId, assignedApprovers[index], client, index + 1);
    }

    return getApprovalRoute(routeId, client);
  });
}

async function addApprovalRouteAssignment(routeId, assignmentData, executor = { query }, requestedOrder = null) {
  const normalizedRouteId = normalize(routeId);
  const route = await getApprovalRoute(normalizedRouteId, executor);

  if (!route) {
    throw new AppError('Approval route not found.', 404, 'APPROVAL_ROUTE_NOT_FOUND');
  }

  const assignment = await validateAssignedApprover(assignmentData, executor);
  const orderResult = await executor.query(
    `
      SELECT COALESCE(MAX(step_order), 0) AS max_order
      FROM overtime_plan_approval_route_steps
      WHERE route_id = $1;
    `,
    [normalizedRouteId]
  );
  const nextOrder = requestedOrder || (Number(orderResult.rows[0].max_order) + 1);

  const duplicate = await executor.query(
    `
      SELECT step_id
      FROM overtime_plan_approval_route_steps
      WHERE route_id = $1
        AND approver_role = $2
        AND approver_user_id IS NOT DISTINCT FROM NULLIF($3, '')
      LIMIT 1;
    `,
    [normalizedRouteId, assignment.approverRole, assignment.approverUserId]
  );

  if (duplicate.rows.length > 0) {
    throw new AppError('This approver is already assigned to this route.', 409, 'DUPLICATE_APPROVER_ASSIGNMENT');
  }

  const result = await executor.query(
    `
      INSERT INTO overtime_plan_approval_route_steps (
        step_id,
        route_id,
        step_order,
        step_name,
        approver_role,
        approver_user_id
      )
      VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''))
      RETURNING step_id;
    `,
    [makeId('OTASSIGN'), normalizedRouteId, nextOrder, assignment.approvalLabel, assignment.approverRole, assignment.approverUserId]
  );

  const assignmentResult = await executor.query(
    `
      ${stepSelect}
      WHERE s.step_id = $1
      LIMIT 1;
    `,
    [result.rows[0].step_id]
  );

  return mapAssignedApprover(assignmentResult.rows[0]);
}

async function addApprovalRouteStep(routeId, stepData, executor = { query }) {
  return addApprovalRouteAssignment(routeId, {
    approverRole: stepData.approverRole || stepData.role,
    approverUserId: stepData.approverUserId || stepData.userId,
    approvalLabel: stepData.stepName || stepData.name,
  }, executor, stepData.stepOrder || null);
}

async function deleteApprovalRouteAssignment(routeId, assignmentId) {
  const result = await query(
    `
      DELETE FROM overtime_plan_approval_route_steps
      WHERE route_id = $1
        AND step_id = $2
      RETURNING step_id;
    `,
    [normalize(routeId), normalize(assignmentId)]
  );

  if (result.rows.length === 0) {
    throw new AppError('Approval route assignment not found.', 404, 'APPROVAL_ASSIGNMENT_NOT_FOUND');
  }

  return { assignmentId: result.rows[0].step_id };
}

async function deleteApprovalRouteStep(routeId, stepId) {
  return deleteApprovalRouteAssignment(routeId, stepId);
}

async function setApprovalRouteStatus(routeId, status) {
  const normalizedStatus = normalizeRouteStatus(status);

  return transaction(async (client) => {
    const route = await getApprovalRoute(routeId, client);

    if (!route) {
      throw new AppError('Approval route not found.', 404, 'APPROVAL_ROUTE_NOT_FOUND');
    }

    if (normalizedStatus === 'active') {
      await client.query(
        `UPDATE overtime_plan_approval_routes SET status = 'inactive', updated_at = NOW() WHERE department_id = $1;`,
        [route.departmentId]
      );
    }

    await client.query(
      `UPDATE overtime_plan_approval_routes SET status = $2, updated_at = NOW() WHERE route_id = $1;`,
      [route.routeId, normalizedStatus]
    );

    return getApprovalRoute(route.routeId, client);
  });
}

async function ensureEmployeePlanPeriodIsAvailable(plan, executor = { query }) {
  const lockKey = [
    'employee-plan-submit',
    plan.departmentId,
    plan.periodType,
    plan.periodStartDate,
    plan.periodEndDate,
  ].join(':');

  await executor.query(
    'SELECT pg_advisory_xact_lock(hashtext($1)::BIGINT);',
    [lockKey]
  );

  const finalizedPeriodResult = await executor.query(
    `
      SELECT plan_id, status
      FROM overtime_plans
      WHERE plan_id <> $1
        AND department_id = $2
        AND COALESCE(plan_scope, 'employee') = 'department'
        AND period_type = $3
        AND period_start_date = $4
        AND period_end_date = $5
        AND status IN ('approved', 'closed')
      LIMIT 1;
    `,
    [
      plan.planId,
      plan.departmentId,
      plan.periodType,
      plan.periodStartDate,
      plan.periodEndDate,
    ]
  );

  if (finalizedPeriodResult.rows.length > 0) {
    throw new AppError(
      'This overtime period already has an approved final Department OT Plan. New employee plans cannot be submitted for this period.',
      409,
      'PLAN_PERIOD_ALREADY_FINALIZED'
    );
  }

  const duplicateEmployeePlanResult = await executor.query(
    `
      SELECT DISTINCT other_plan.plan_id, other_plan.status
      FROM overtime_plans other_plan
      INNER JOIN overtime_plan_items other_item
        ON other_item.plan_id = other_plan.plan_id
      INNER JOIN overtime_plan_items current_item
        ON current_item.plan_id = $1
       AND current_item.employee_id = other_item.employee_id
      WHERE other_plan.plan_id <> $1
        AND other_plan.department_id = $2
        AND COALESCE(other_plan.plan_scope, 'employee') = 'employee'
        AND other_plan.period_type = $3
        AND other_plan.period_start_date = $4
        AND other_plan.period_end_date = $5
        AND other_plan.status = ANY($6::TEXT[])
      LIMIT 1;
    `,
    [
      plan.planId,
      plan.departmentId,
      plan.periodType,
      plan.periodStartDate,
      plan.periodEndDate,
      BLOCKING_EMPLOYEE_PLAN_STATUSES,
    ]
  );

  if (duplicateEmployeePlanResult.rows.length > 0) {
    throw new AppError(
      'Another active employee overtime plan already exists for this employee and period. Delete or resolve the other plan before submitting.',
      409,
      'DUPLICATE_ACTIVE_EMPLOYEE_PLAN'
    );
  }
}

async function submitEmployeePlanToSupervisorWithExecutor(planId, actionBy, remarks, executor) {
    const plan = await getOvertimePlan(planId, {}, executor);

    if (!plan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    if ((plan.planScope || 'employee') !== 'employee') {
      throw new AppError('Only employee OT plan drafts can be submitted to supervisor.', 400, 'PLAN_SCOPE_NOT_EMPLOYEE');
    }

    if (!['draft', 'supervisor_returned', 'returned_for_revision'].includes(plan.status)) {
      throw new AppError('Only draft or returned employee OT plans can be submitted.', 400, 'PLAN_SUBMIT_NOT_ALLOWED');
    }

    if (plan.itemCount === 0) {
      throw new AppError('Add at least one plan item before submitting the overtime plan.', 400, 'PLAN_HAS_NO_ITEMS');
    }

    await ensureEmployeePlanPeriodIsAvailable(plan, executor);

    await executor.query(
      `
        UPDATE overtime_plans
        SET status = 'submitted_to_supervisor',
            submitted_by = $2,
            submitted_at = NOW(),
            rejection_reason = NULL,
            updated_at = NOW()
        WHERE plan_id = $1;
      `,
      [plan.planId, normalize(actionBy)]
    );

    await addPlanLog(plan.planId, 'submitted_to_supervisor', actionBy, remarks || 'Employee OT plan submitted to supervisor.', executor);
    return getOvertimePlan(plan.planId, {}, executor);
}

async function submitEmployeePlanToSupervisor(planId, actionBy, remarks) {
  return transaction(async (client) => {
    return submitEmployeePlanToSupervisorWithExecutor(planId, actionBy, remarks, client);
  });
}

async function getUnsignedEmployeeIdsForPlan(planId, executor = { query }) {
  const result = await executor.query(
    `
      SELECT DISTINCT opi.employee_id
      FROM overtime_plan_items opi
      LEFT JOIN overtime_plan_signature_records signature_record
        ON signature_record.plan_id = opi.plan_id
       AND signature_record.employee_id = opi.employee_id
       AND signature_record.status = 'active'
       AND signature_record.signer_role = 'employee'
       AND signature_record.confirmation_method = 'self'
      WHERE opi.plan_id = $1
        AND signature_record.signature_record_id IS NULL
      ORDER BY opi.employee_id ASC;
    `,
    [normalize(planId)]
  );

  return result.rows.map((row) => row.employee_id);
}

async function supersedeEmployeePlanSignatures(planId, executor = { query }) {
  await executor.query(
    `
      UPDATE overtime_plan_signature_records
      SET status = 'superseded',
          updated_at = NOW()
      WHERE plan_id = $1
        AND status = 'active';
    `,
    [normalize(planId)]
  );
}

async function supervisorReviewEmployeePlan(planId, action, actionBy, remarks) {
  const normalizedAction = normalize(action).toLowerCase();

  if (!['accept', 'return'].includes(normalizedAction)) {
    throw new AppError('Supervisor action must be accept or return.', 400, 'INVALID_SUPERVISOR_REVIEW_ACTION');
  }

  return transaction(async (client) => {
    await client.query(
      'SELECT plan_id FROM overtime_plans WHERE plan_id = $1 FOR UPDATE;',
      [normalize(planId)]
    );

    const plan = await getOvertimePlan(planId, {}, client);

    if (!plan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    if ((plan.planScope || 'employee') !== 'employee') {
      throw new AppError('Supervisor can only review employee OT plans.', 400, 'PLAN_SCOPE_NOT_EMPLOYEE');
    }

    if (plan.status !== 'submitted_to_supervisor') {
      throw new AppError('Only plans submitted to supervisor can be reviewed.', 400, 'PLAN_NOT_SUBMITTED_TO_SUPERVISOR');
    }

    const unassignedEmployees = await client.query(
      `
        SELECT DISTINCT e.employee_id
        FROM overtime_plan_items opi
        INNER JOIN employees e ON e.employee_id = opi.employee_id
        WHERE opi.plan_id = $1
          AND e.supervisor_user_id IS DISTINCT FROM $2
        LIMIT 1;
      `,
      [plan.planId, normalize(actionBy)]
    );

    if (unassignedEmployees.rows.length > 0) {
      throw new AppError(
        'You may review only overtime plans for employees assigned to you.',
        403,
        'SUPERVISOR_EMPLOYEE_REVIEW_FORBIDDEN'
      );
    }

    if (normalizedAction === 'accept') {
      const unsignedEmployeeIds = await getUnsignedEmployeeIdsForPlan(plan.planId, client);

      if (unsignedEmployeeIds.length > 0) {
        throw new AppError(
          'Every employee in the overtime plan must submit their own active signature before acceptance.',
          400,
          'EMPLOYEE_SIGNATURE_REQUIRED'
        );
      }
    }

    const nextStatus = normalizedAction === 'accept' ? 'supervisor_accepted' : 'supervisor_returned';
    const logAction = normalizedAction === 'accept' ? 'supervisor_accepted' : 'supervisor_returned';

    await client.query(
      `
        UPDATE overtime_plans
        SET status = $2,
            supervisor_reviewed_by = $3,
            supervisor_reviewed_at = NOW(),
            rejection_reason = CASE WHEN $2 = 'supervisor_returned' THEN $4 ELSE NULL END,
            updated_at = NOW()
        WHERE plan_id = $1;
      `,
      [plan.planId, nextStatus, normalize(actionBy), nullable(remarks)]
    );

    if (normalizedAction === 'return') {
      await supersedeEmployeePlanSignatures(plan.planId, client);
    }

    await addPlanLog(plan.planId, logAction, actionBy, remarks || `Employee OT plan ${logAction}.`, client);
    return getOvertimePlan(plan.planId, {}, client);
  });
}

async function getSupervisorPlanDashboard(filters = {}) {
  const departmentId = normalize(filters.departmentId);
  const supervisorUserId = normalize(filters.supervisorUserId);
  const includeUnassigned = normalizeBool(filters.includeUnassigned, true);
  const periodType = normalizePeriodType(filters.periodType || 'weekly');
  const periodStartDate = normalizeDate(filters.periodStartDate || filters.startDate, 'periodStartDate');
  const periodEndDate = normalizeDate(filters.periodEndDate || filters.endDate, 'periodEndDate');
  validatePlanPeriod(periodType, periodStartDate, periodEndDate);

  if (!departmentId) {
    throw new AppError('Department ID is required.', 400, 'DEPARTMENT_REQUIRED');
  }

  const employeeParams = [departmentId];
  let supervisorClause = '';

  if (supervisorUserId) {
    employeeParams.push(supervisorUserId);
    const supervisorParam = employeeParams.length;
    supervisorClause = includeUnassigned
      ? `AND (e.supervisor_user_id = $${supervisorParam} OR e.supervisor_user_id IS NULL)`
      : `AND e.supervisor_user_id = $${supervisorParam}`;
  }

  const employeeResult = await query(
    `
      SELECT
        e.employee_id,
        e.employee_no,
        e.user_id,
        e.position,
        e.supervisor_user_id,
        u.first_name,
        u.middle_name,
        u.last_name,
        u.email,
        u.role
      FROM employees e
      INNER JOIN users u ON u.id = e.user_id
      WHERE e.department_id = $1
        AND e.status = 'active'
        AND u.status = 'active'
        ${supervisorClause}
      ORDER BY u.last_name ASC, u.first_name ASC;
    `,
    employeeParams
  );

  const planResult = await query(
    `
      SELECT
        op.plan_id,
        op.created_by,
        op.status,
        op.remarks,
        op.rejection_reason,
        op.created_at,
        op.updated_at,
        opi.employee_id,
        COUNT(opi.plan_item_id)::INTEGER AS item_count,
        COALESCE(SUM(opi.planned_hours), 0)::NUMERIC AS planned_hours,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'planItemId', opi.plan_item_id,
            'plannedDate', opi.planned_date,
            'plannedHours', opi.planned_hours,
            'reason', opi.reason
          )
          ORDER BY opi.planned_date ASC, opi.plan_item_id ASC
        ) AS items,
        signature_record.signature_record_id,
        signature_record.signer_role,
        signature_record.confirmation_method,
        signature_record.signature_file_path,
        signature_record.signature_mime_type,
        signature_record.signed_at
      FROM overtime_plans op
      INNER JOIN overtime_plan_items opi ON opi.plan_id = op.plan_id
      LEFT JOIN overtime_plan_signature_records signature_record
        ON signature_record.plan_id = op.plan_id
       AND signature_record.employee_id = opi.employee_id
       AND signature_record.status = 'active'
       AND signature_record.signer_role = 'employee'
       AND signature_record.confirmation_method = 'self'
      WHERE op.department_id = $1
        AND COALESCE(op.plan_scope, 'employee') = 'employee'
        AND op.period_type = $2
        AND op.period_start_date = $3
        AND op.period_end_date = $4
      GROUP BY
        op.plan_id,
        op.created_by,
        op.status,
        op.remarks,
        op.rejection_reason,
        op.created_at,
        op.updated_at,
        opi.employee_id,
        signature_record.signature_record_id,
        signature_record.signer_role,
        signature_record.confirmation_method,
        signature_record.signature_file_path,
        signature_record.signature_mime_type,
        signature_record.signed_at;
    `,
    [departmentId, periodType, periodStartDate, periodEndDate]
  );

  const departmentPlanResult = await query(
    `
      SELECT plan_id, status, remarks, created_at, updated_at
      FROM overtime_plans
      WHERE department_id = $1
        AND COALESCE(plan_scope, 'employee') = 'department'
        AND period_type = $2
        AND period_start_date = $3
        AND period_end_date = $4
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1;
    `,
    [departmentId, periodType, periodStartDate, periodEndDate]
  );

  const latestPlanByEmployee = new Map();
  const dashboardStatusPriority = {
    supervisor_accepted: 4,
    submitted_to_supervisor: 3,
    supervisor_returned: 2,
    returned_for_revision: 2,
    draft: 1,
  };

  for (const row of planResult.rows) {
    const current = latestPlanByEmployee.get(row.employee_id);
    const updatedAt = iso(row.updated_at || row.created_at);
    const nextPriority = dashboardStatusPriority[row.status] || 0;
    const currentPriority = dashboardStatusPriority[current?.status] || 0;
    if (
      !current
      || nextPriority > currentPriority
      || (nextPriority === currentPriority && updatedAt > current.updatedAt)
    ) {
      latestPlanByEmployee.set(row.employee_id, {
        planId: row.plan_id,
        employeeId: row.employee_id,
        status: row.status,
        itemCount: toNumber(row.item_count),
        plannedHours: toNumber(row.planned_hours),
        remarks: row.remarks || '',
        rejectionReason: row.rejection_reason || '',
        createdAt: iso(row.created_at),
        updatedAt,
        items: Array.isArray(row.items)
          ? row.items.map((item) => ({
              planItemId: item.planItemId,
              plannedDate: dateOnly(item.plannedDate),
              plannedHours: toNumber(item.plannedHours),
              reason: item.reason || '',
            }))
          : [],
        signature: row.signature_record_id
          ? {
              signatureRecordId: row.signature_record_id,
              signerRole: row.signer_role,
              confirmationMethod: row.confirmation_method,
              mimeType: row.signature_mime_type || '',
              signedAt: iso(row.signed_at),
              signedUrl: '',
              previewAvailable: false,
              _filePath: row.signature_file_path,
            }
          : null,
      });
    }
  }

  const submittedStatuses = new Set(['submitted_to_supervisor', 'supervisor_accepted']);
  const employees = await Promise.all(employeeResult.rows.map(async (row) => {
    const plan = latestPlanByEmployee.get(row.employee_id) || null;
    let publicPlan = plan;

    if (plan && plan.signature) {
      const { _filePath, ...signature } = plan.signature;
      let preview = {};

      try {
        preview = await createSignatureSignedUrl(_filePath);
      } catch (error) {
        preview = {};
      }

      publicPlan = {
        ...plan,
        signature: {
          ...signature,
          ...preview,
          previewAvailable: Boolean(preview.signedUrl),
        },
      };
    }

    const hasSignedSubmission = Boolean(
      publicPlan
      && submittedStatuses.has(publicPlan.status)
      && publicPlan.signature
    );
    const submissionState = !publicPlan
      ? 'not_submitted'
      : publicPlan.status === 'supervisor_accepted' && publicPlan.signature
        ? 'accepted_signed'
        : publicPlan.status === 'submitted_to_supervisor' && publicPlan.signature
          ? 'submitted_signed'
          : submittedStatuses.has(publicPlan.status)
            ? 'submitted_unsigned'
            : publicPlan.status === 'supervisor_returned'
              ? 'returned'
              : publicPlan.status === 'draft'
                ? 'draft'
                : 'not_submitted';

    return {
      employeeId: row.employee_id,
      employeeNo: row.employee_no || '',
      userId: row.user_id,
      employeeName: buildFullName({ firstName: row.first_name, middleName: row.middle_name, lastName: row.last_name }),
      email: row.email || '',
      role: row.role || '',
      position: row.position || '',
      supervisorUserId: row.supervisor_user_id || '',
      hasPlan: Boolean(publicPlan),
      hasSignedSubmission,
      eligibleForDepartmentPlan: Boolean(
        publicPlan
        && publicPlan.status === 'supervisor_accepted'
        && publicPlan.signature
      ),
      submissionState,
      plan: publicPlan,
    };
  }));

  const returnedStatuses = new Set(['supervisor_returned']);
  const acceptedStatuses = new Set(['supervisor_accepted']);

  return {
    departmentId,
    supervisorUserId,
    includeUnassigned,
    periodType,
    periodStartDate,
    periodEndDate,
    totalEmployees: employees.length,
    submittedCount: employees.filter((employee) => employee.plan && submittedStatuses.has(employee.plan.status)).length,
    acceptedCount: employees.filter((employee) => employee.plan && acceptedStatuses.has(employee.plan.status)).length,
    returnedCount: employees.filter((employee) => employee.plan && returnedStatuses.has(employee.plan.status)).length,
    missingCount: employees.filter((employee) => !employee.plan).length,
    signedSubmissionCount: employees.filter((employee) => employee.hasSignedSubmission).length,
    unsignedSubmissionCount: employees.filter((employee) => (
      employee.plan
      && submittedStatuses.has(employee.plan.status)
      && !employee.plan.signature
    )).length,
    eligibleEmployeeCount: employees.filter((employee) => employee.eligibleForDepartmentPlan).length,
    notSubmittedCount: employees.filter((employee) => !employee.hasSignedSubmission).length,
    includedPlannedHours: employees
      .filter((employee) => employee.hasSignedSubmission)
      .reduce((total, employee) => total + employee.plan.plannedHours, 0),
    departmentPlan: departmentPlanResult.rows[0]
      ? {
          planId: departmentPlanResult.rows[0].plan_id,
          status: departmentPlanResult.rows[0].status,
          remarks: departmentPlanResult.rows[0].remarks || '',
          createdAt: iso(departmentPlanResult.rows[0].created_at),
          updatedAt: iso(departmentPlanResult.rows[0].updated_at),
        }
      : null,
    employees,
  };
}

async function createDepartmentPlanFromEmployeeDrafts(planData, createdBy) {
  const departmentId = normalize(planData.departmentId);
  const supervisorUserId = normalize(planData.supervisorUserId);
  const periodType = normalizePeriodType(planData.periodType || 'weekly');
  const periodStartDate = normalizeDate(planData.periodStartDate, 'periodStartDate');
  const periodEndDate = normalizeDate(planData.periodEndDate, 'periodEndDate');
  validatePlanPeriod(periodType, periodStartDate, periodEndDate);

  if (!departmentId) {
    throw new AppError('Department ID is required.', 400, 'DEPARTMENT_REQUIRED');
  }

  return transaction(async (client) => {
    const lockKey = [
      'department-plan-create',
      departmentId,
      periodType,
      periodStartDate,
      periodEndDate,
    ].join(':');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1)::BIGINT);',
      [lockKey]
    );

    const existingDepartmentPlan = await client.query(
      `
        SELECT plan_id, status
        FROM overtime_plans
        WHERE department_id = $1
          AND COALESCE(plan_scope, 'employee') = 'department'
          AND period_type = $2
          AND period_start_date = $3
          AND period_end_date = $4
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1;
      `,
      [departmentId, periodType, periodStartDate, periodEndDate]
    );

    if (existingDepartmentPlan.rows.length > 0) {
      throw new AppError(
        'A Department OT Plan already exists for this period.',
        409,
        'DEPARTMENT_PLAN_ALREADY_EXISTS'
      );
    }

    const acceptedPlans = await client.query(
      `
        SELECT op.plan_id
        FROM overtime_plans op
        WHERE op.department_id = $1
          AND COALESCE(op.plan_scope, 'employee') = 'employee'
          AND op.period_type = $2
          AND op.period_start_date = $3
          AND op.period_end_date = $4
          AND op.status = 'supervisor_accepted'
          AND (
            $5 = ''
            OR EXISTS (
              SELECT 1
              FROM overtime_plan_items scoped_item
              INNER JOIN employees scoped_employee
                ON scoped_employee.employee_id = scoped_item.employee_id
              WHERE scoped_item.plan_id = op.plan_id
                AND scoped_employee.supervisor_user_id = $5
            )
          )
        ORDER BY op.created_at ASC;
      `,
      [departmentId, periodType, periodStartDate, periodEndDate, supervisorUserId]
    );

    if (acceptedPlans.rows.length === 0) {
      throw new AppError('No supervisor-accepted employee OT plans found for this period.', 400, 'NO_ACCEPTED_EMPLOYEE_PLANS');
    }

    const acceptedPlanIds = acceptedPlans.rows.map((row) => row.plan_id);
    const unsignedItems = await client.query(
      `
        SELECT DISTINCT opi.plan_id, opi.employee_id
        FROM overtime_plan_items opi
        LEFT JOIN overtime_plan_signature_records signature_record
          ON signature_record.plan_id = opi.plan_id
         AND signature_record.employee_id = opi.employee_id
         AND signature_record.status = 'active'
         AND signature_record.signer_role = 'employee'
         AND signature_record.confirmation_method = 'self'
        WHERE opi.plan_id = ANY($1)
          AND signature_record.signature_record_id IS NULL
        ORDER BY opi.plan_id ASC, opi.employee_id ASC;
      `,
      [acceptedPlanIds]
    );

    if (unsignedItems.rows.length > 0) {
      throw new AppError(
        'A supervisor-accepted employee plan is missing an active employee self-signature.',
        409,
        'ACCEPTED_PLAN_SIGNATURE_MISSING'
      );
    }

    const itemResult = await client.query(
      `
        SELECT DISTINCT ON (opi.employee_id, opi.planned_date)
          opi.employee_id,
          opi.planned_date,
          opi.planned_hours,
          opi.reason,
          opi.plan_id AS source_employee_plan_id
        FROM overtime_plan_items opi
        INNER JOIN overtime_plans op ON op.plan_id = opi.plan_id
        INNER JOIN overtime_plan_signature_records signature_record
          ON signature_record.plan_id = opi.plan_id
         AND signature_record.employee_id = opi.employee_id
         AND signature_record.status = 'active'
         AND signature_record.signer_role = 'employee'
         AND signature_record.confirmation_method = 'self'
        WHERE op.plan_id = ANY($1)
        ORDER BY opi.employee_id, opi.planned_date, op.updated_at DESC;
      `,
      [acceptedPlanIds]
    );

    if (itemResult.rows.length === 0) {
      throw new AppError('Accepted employee plans do not contain plan items.', 400, 'NO_ACCEPTED_PLAN_ITEMS');
    }

    const planId = makeId('DEPTPLAN');
    await client.query(
      `
        INSERT INTO overtime_plans (
          plan_id,
          department_id,
          period_type,
          period_start_date,
          period_end_date,
          status,
          plan_scope,
          created_by,
          remarks
        )
        VALUES ($1, $2, $3, $4, $5, 'draft', 'department', $6, $7);
      `,
      [planId, departmentId, periodType, periodStartDate, periodEndDate, normalize(createdBy), nullable(planData.remarks)]
    );

    for (const item of itemResult.rows) {
      await client.query(
        `
          INSERT INTO overtime_plan_items (
            plan_item_id,
            plan_id,
            employee_id,
            planned_date,
            planned_hours,
            reason,
            source_employee_plan_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7);
        `,
        [
          makeId('PLANITEM'),
          planId,
          item.employee_id,
          dateOnly(item.planned_date),
          item.planned_hours,
          item.reason,
          item.source_employee_plan_id,
        ]
      );
    }

    await addPlanLog(planId, 'department_plan_created_from_employee_drafts', createdBy, `${itemResult.rows.length} item(s) copied from accepted employee OT plans.`, client);
    return getOvertimePlan(planId, {}, client);
  });
}

function buildApprovalAssignments(activeRoute) {
  const assignedApprovers = activeRoute && Array.isArray(activeRoute.assignedApprovers)
    ? activeRoute.assignedApprovers
    : [];

  if (!activeRoute || assignedApprovers.length === 0) {
    throw new AppError('No active approval assignment rule found for this department.', 404, 'APPROVAL_ROUTE_NOT_FOUND');
  }

  const hasSupervisor = assignedApprovers.some((approver) => approver.approverRole === 'supervisor');
  const hasFinalApprover = assignedApprovers.some((approver) => isFinalApprovalRole(approver.approverRole));

  if (!hasSupervisor) {
    throw new AppError('The active approval rule must have one assigned supervisor approver.', 400, 'SUPERVISOR_APPROVER_REQUIRED');
  }

  if (!hasFinalApprover) {
    return [
      ...assignedApprovers,
      {
        assignmentId: '',
        routeId: activeRoute.routeId,
        approverRole: 'hr',
        approverUserId: '',
        approverName: '',
        approvalLabel: createApprovalLabel('hr'),
      },
    ];
  }

  return assignedApprovers.map((approver) => ({
    ...approver,
    approverRole: isFinalApprovalRole(approver.approverRole) ? 'hr' : approver.approverRole,
    approvalLabel: approver.approvalLabel || createApprovalLabel(approver.approverRole),
  }));
}

async function getPendingApprovals(planId, executor = { query }) {
  const result = await executor.query(
    `
      ${approvalSelect}
      WHERE a.plan_id = $1
        AND a.status = 'pending'
      ORDER BY
        CASE WHEN a.approver_role IN ('hr', 'admin') THEN 1 ELSE 0 END,
        a.step_order ASC,
        a.created_at ASC;
    `,
    [normalize(planId)]
  );

  return result.rows.map(mapPlanApproval);
}

async function getPendingApproval(planId, executor = { query }) {
  const approvals = await getPendingApprovals(planId, executor);
  return approvals[0] || null;
}

async function getPendingApprovalForUser(planId, user, executor = { query }) {
  const pendingApprovals = await getPendingApprovals(planId, executor);
  const userApprovals = pendingApprovals.filter((approval) => canUserActOnApproval(user, approval));

  if (userApprovals.length === 0) {
    return null;
  }

  const preliminaryApproval = userApprovals.find((approval) => !isFinalApprovalRole(approval.approverRole));
  return preliminaryApproval || userApprovals.find((approval) => isFinalApprovalRole(approval.approverRole)) || null;
}

async function getPendingPreliminaryApprovals(planId, executor = { query }) {
  const pendingApprovals = await getPendingApprovals(planId, executor);
  return pendingApprovals.filter((approval) => !isFinalApprovalRole(approval.approverRole));
}

async function skipOtherFinalApprovals(planId, approvedApprovalId, actionByUser, remarks, executor = { query }) {
  await executor.query(
    `
      UPDATE overtime_plan_approvals
      SET status = 'skipped',
          acted_by = $3,
          acted_at = NOW(),
          remarks = $4
      WHERE plan_id = $1
        AND approval_id <> $2
        AND status = 'pending'
        AND approver_role IN ('hr', 'admin');
    `,
    [
      normalize(planId),
      normalize(approvedApprovalId),
      actionByUser.id,
      remarks || 'Skipped because final approval was already completed by HR/Admin.',
    ]
  );
}

async function updateCurrentApprovalSummary(planId, executor = { query }) {
  const nextApproval = await getPendingApproval(planId, executor);

  if (!nextApproval) {
    await executor.query(
      `
        UPDATE overtime_plans
        SET current_step_order = NULL,
            current_approval_id = NULL,
            current_approver_role = NULL,
            current_approver_user_id = NULL,
            updated_at = NOW()
        WHERE plan_id = $1;
      `,
      [normalize(planId)]
    );
    return null;
  }

  await executor.query(
    `
      UPDATE overtime_plans
      SET current_step_order = $2,
          current_approval_id = $3,
          current_approver_role = $4,
          current_approver_user_id = NULLIF($5, ''),
          updated_at = NOW()
      WHERE plan_id = $1;
    `,
    [normalize(planId), nextApproval.stepOrder, nextApproval.approvalId, nextApproval.approverRole, nextApproval.approverUserId || '']
  );

  return nextApproval;
}

async function ensureDepartmentApprovalAccess(user, plan, approval) {
  if (approval.approverRole !== 'supervisor' || user.role === 'admin') {
    return;
  }

  const employee = await getEmployeeByUserId(user.id);

  if (!employee || employee.departmentId !== plan.departmentId) {
    throw new AppError('You can only approve supervisor-level OT plans for your own department.', 403, 'APPROVER_DEPARTMENT_MISMATCH');
  }
}

function canUserActOnApproval(user, approval) {
  if (!user || !approval) {
    return false;
  }

  if (isFinalApprovalRole(approval.approverRole)) {
    // HR and Admin are one final approval group.
    // A pending HR/Admin final approval can be completed by either role.
    return ['hr', 'admin'].includes(user.role);
  }

  if (approval.approverUserId) {
    return approval.approverUserId === user.id;
  }

  if (approval.approverRole === 'supervisor') {
    return user.role === 'supervisor';
  }

  return user.role === approval.approverRole;
}

async function startDepartmentPlanApproval(planId, actionByUser, remarks) {
  return transaction(async (client) => {
    const plan = await getOvertimePlan(planId, {}, client);

    if (!plan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    if ((plan.planScope || 'employee') !== 'department') {
      throw new AppError('Only department OT plans can be submitted to the approval route.', 400, 'PLAN_SCOPE_NOT_DEPARTMENT');
    }

    if (!['draft', 'returned_for_revision'].includes(plan.status)) {
      throw new AppError('Only draft or returned department OT plans can be submitted for approval.', 400, 'PLAN_APPROVAL_SUBMIT_NOT_ALLOWED');
    }

    if (plan.itemCount === 0) {
      throw new AppError('Add at least one plan item before submitting the department OT plan.', 400, 'PLAN_HAS_NO_ITEMS');
    }

    const activeRoute = await getActiveApprovalRouteForDepartment(plan.departmentId, client);
    const assignedApprovers = buildApprovalAssignments(activeRoute);
    let supervisorSubmission = null;

    if (actionByUser.role === 'supervisor') {
      const supervisorAssignment = assignedApprovers.find((approver) => (
        approver.approverRole === 'supervisor'
        && approver.approverUserId === actionByUser.id
      ));

      if (!supervisorAssignment) {
        throw new AppError(
          'You must be the assigned supervisor approver to submit and sign this Department OT Plan.',
          403,
          'SUPERVISOR_APPROVAL_ASSIGNMENT_MISMATCH'
        );
      }

      const savedSignature = await getUserSignature(actionByUser.id, client);

      if (!savedSignature) {
        throw new AppError(
          'Save a signature before submitting this Department OT Plan for approval.',
          400,
          'SIGNATURE_REQUIRED'
        );
      }

      supervisorSubmission = {
        assignment: supervisorAssignment,
        signature: savedSignature,
      };
    }

    await client.query('DELETE FROM overtime_plan_approvals WHERE plan_id = $1;', [plan.planId]);

    let supervisorSubmissionApprovalId = '';
    for (let index = 0; index < assignedApprovers.length; index += 1) {
      const approver = assignedApprovers[index];
      const approvalId = makeId('OTAPPROVAL');
      await client.query(
        `
          INSERT INTO overtime_plan_approvals (
            approval_id,
            plan_id,
            route_id,
            step_id,
            step_order,
            step_name,
            approver_role,
            approver_user_id,
            status
          )
          VALUES ($1, $2, $3, NULL, $4, $5, $6, NULLIF($7, ''), 'pending');
        `,
        [
          approvalId,
          plan.planId,
          activeRoute.routeId,
          index + 1,
          approver.approvalLabel || createApprovalLabel(approver.approverRole),
          approver.approverRole,
          approver.approverUserId || '',
        ]
      );

      if (supervisorSubmission && approver === supervisorSubmission.assignment) {
        supervisorSubmissionApprovalId = approvalId;
      }
    }

    if (supervisorSubmission) {
      await client.query(
        `
          UPDATE overtime_plan_approvals
          SET status = 'approved',
              acted_by = $2,
              acted_at = NOW(),
              remarks = $3,
              signature_file_path = $4,
              signature_mime_type = $5
          WHERE approval_id = $1
            AND status = 'pending';
        `,
        [
          supervisorSubmissionApprovalId,
          actionByUser.id,
          nullable(remarks) || 'Department OT Plan submitted and signed by the supervisor.',
          supervisorSubmission.signature.signatureFilePath,
          supervisorSubmission.signature.mimeType,
        ]
      );
    }

    const firstPendingApproval = await getPendingApproval(plan.planId, client);

    await client.query(
      `
        UPDATE overtime_plans
        SET status = 'pending_approval',
            route_id = $2,
            current_step_order = $3,
            current_approval_id = $4,
            current_approver_role = $5,
            current_approver_user_id = NULLIF($6, ''),
            department_submitted_by = $7,
            department_submitted_at = NOW(),
            rejection_reason = NULL,
            updated_at = NOW()
        WHERE plan_id = $1;
      `,
      [
        plan.planId,
        activeRoute.routeId,
        firstPendingApproval ? firstPendingApproval.stepOrder : null,
        firstPendingApproval ? firstPendingApproval.approvalId : null,
        firstPendingApproval ? firstPendingApproval.approverRole : null,
        firstPendingApproval ? firstPendingApproval.approverUserId || '' : '',
        actionByUser.id,
      ]
    );

    await addPlanLog(
      plan.planId,
      supervisorSubmission
        ? 'department_plan_submitted_and_signed_by_supervisor'
        : 'department_plan_submitted_for_assigned_approval',
      actionByUser.id,
      remarks || (supervisorSubmission
        ? 'Department OT Plan submitted and signed by the supervisor.'
        : 'Department OT plan submitted to assigned approvers.'),
      client
    );
    return getDepartmentPlanApprovalDetails(plan.planId, client);
  });
}

async function getDepartmentPlanApprovalDetails(planId, executor = { query }) {
  const plan = await getOvertimePlan(planId, {}, executor);

  if (!plan) {
    return null;
  }

  const approvalResult = await executor.query(
    `
      ${approvalSelect}
      WHERE a.plan_id = $1
      ORDER BY a.step_order ASC;
    `,
    [plan.planId]
  );

  return {
    ...plan,
    approvals: approvalResult.rows.map(mapPlanApproval),
  };
}

async function approveDepartmentPlanStep(planId, actionByUser, remarks) {
  return transaction(async (client) => {
    const plan = await getOvertimePlan(planId, {}, client);

    if (!plan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    if (plan.status !== 'pending_approval') {
      throw new AppError('Only department plans pending approval can be approved.', 400, 'PLAN_NOT_PENDING_APPROVAL');
    }

    const approvalToActOn = await getPendingApprovalForUser(plan.planId, actionByUser, client);

    if (!approvalToActOn) {
      throw new AppError('You are not assigned as a pending approver for this department OT plan.', 403, 'NOT_ASSIGNED_APPROVER');
    }

    const pendingPreliminaryApprovals = await getPendingPreliminaryApprovals(plan.planId, client);
    const isFinalApproval = isFinalApprovalRole(approvalToActOn.approverRole);

    if (isFinalApproval && pendingPreliminaryApprovals.length > 0) {
      throw new AppError(
        'Supervisor and Japanese Management approvals must be completed before HR/Admin final approval.',
        400,
        'PRELIMINARY_APPROVALS_PENDING'
      );
    }

    await ensureDepartmentApprovalAccess(actionByUser, plan, approvalToActOn);

    const approverSignature = await getUserSignature(actionByUser.id, client);

    if (!approverSignature) {
      throw new AppError(
        'Save a signature before approving this Department OT Plan.',
        400,
        'SIGNATURE_REQUIRED'
      );
    }

    const approvalResult = await client.query(
      `
        UPDATE overtime_plan_approvals
        SET status = 'approved',
            acted_by = $2,
            acted_at = NOW(),
            remarks = $3,
            signature_file_path = $4,
            signature_mime_type = $5
        WHERE approval_id = $1
          AND status = 'pending'
        RETURNING approval_id;
      `,
      [
        approvalToActOn.approvalId,
        actionByUser.id,
        nullable(remarks),
        approverSignature.signatureFilePath,
        approverSignature.mimeType,
      ]
    );

    if (approvalResult.rows.length === 0) {
      throw new AppError(
        'This approval was already processed.',
        409,
        'APPROVAL_ALREADY_PROCESSED'
      );
    }

    if (!isFinalApproval) {
      const nextApproval = await updateCurrentApprovalSummary(plan.planId, client);
      await addPlanLog(plan.planId, 'assigned_preliminary_approval_approved', actionByUser.id, remarks || `${approvalToActOn.stepName} approved.`, client);
      return getDepartmentPlanApprovalDetails(plan.planId, client);
    }

    await skipOtherFinalApprovals(
      plan.planId,
      approvalToActOn.approvalId,
      actionByUser,
      'Skipped because HR/Admin final approval was completed.',
      client
    );

    await client.query(
      `
        UPDATE overtime_plans
        SET status = 'approved',
            approved_by = $2,
            approved_at = NOW(),
            current_step_order = NULL,
            current_approval_id = NULL,
            current_approver_role = NULL,
            current_approver_user_id = NULL,
            rejected_by = NULL,
            rejected_at = NULL,
            rejection_reason = NULL,
            updated_at = NOW()
        WHERE plan_id = $1;
      `,
      [plan.planId, actionByUser.id]
    );

    await addPlanLog(plan.planId, 'department_plan_final_approved', actionByUser.id, remarks || 'Department OT plan final-approved by HR/Admin.', client);
    const actualPeriod = await createActualPeriodFromApprovedPlan(plan.planId, actionByUser.id, client);
    await addPlanLog(
      plan.planId,
      'actual_overtime_period_created',
      actionByUser.id,
      'Actual OT entries were generated from the approved Department OT Plan.',
      client
    );
    const approvedPlan = await getDepartmentPlanApprovalDetails(plan.planId, client);
    return { ...approvedPlan, actualPeriod };
  });
}

async function rejectDepartmentPlanStep(planId, actionByUser, remarks) {
  if (!nullable(remarks)) {
    throw new AppError('Remarks are required when returning a department OT plan for revision.', 400, 'REJECTION_REMARKS_REQUIRED');
  }

  return transaction(async (client) => {
    const plan = await getOvertimePlan(planId, {}, client);

    if (!plan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    if (plan.status !== 'pending_approval') {
      throw new AppError('Only department plans pending approval can be returned.', 400, 'PLAN_NOT_PENDING_APPROVAL');
    }

    const approvalToActOn = await getPendingApprovalForUser(plan.planId, actionByUser, client);

    if (!approvalToActOn) {
      throw new AppError('You are not assigned as a pending approver for this department OT plan.', 403, 'NOT_ASSIGNED_APPROVER');
    }

    const pendingPreliminaryApprovals = await getPendingPreliminaryApprovals(plan.planId, client);

    if (isFinalApprovalRole(approvalToActOn.approverRole) && pendingPreliminaryApprovals.length > 0) {
      throw new AppError(
        'Supervisor and Japanese Management approvals must be completed before HR/Admin final return.',
        400,
        'PRELIMINARY_APPROVALS_PENDING'
      );
    }

    await ensureDepartmentApprovalAccess(actionByUser, plan, approvalToActOn);

    await client.query(
      `
        UPDATE overtime_plan_approvals
        SET status = 'rejected',
            acted_by = $2,
            acted_at = NOW(),
            remarks = $3
        WHERE approval_id = $1;
      `,
      [approvalToActOn.approvalId, actionByUser.id, nullable(remarks)]
    );

    await client.query(
      `
        UPDATE overtime_plan_approvals
        SET status = 'skipped',
            acted_by = $2,
            acted_at = NOW(),
            remarks = $3
        WHERE plan_id = $1
          AND status = 'pending';
      `,
      [plan.planId, actionByUser.id, `Skipped because ${approvalToActOn.stepName} returned the plan for revision.`]
    );

    await client.query(
      `
        UPDATE overtime_plans
        SET status = 'returned_for_revision',
            rejected_by = $2,
            rejected_at = NOW(),
            rejection_reason = $3,
            current_step_order = NULL,
            current_approval_id = NULL,
            current_approver_role = NULL,
            current_approver_user_id = NULL,
            updated_at = NOW()
        WHERE plan_id = $1;
      `,
      [plan.planId, actionByUser.id, nullable(remarks)]
    );

    await addPlanLog(plan.planId, 'department_plan_returned_for_revision', actionByUser.id, remarks, client);
    return getDepartmentPlanApprovalDetails(plan.planId, client);
  });
}


async function resetOvertimePlanStatus(planId, actionByUser, resetData = {}) {
  if (!actionByUser || !['admin', 'hr', 'supervisor'].includes(actionByUser.role)) {
    throw new AppError('Only admin, HR, or a department supervisor can reset overtime plan status.', 403, 'RESET_STATUS_ACCESS_DENIED');
  }

  const remarks = nullable(resetData.remarks || resetData.reason || resetData.correctionReason);

  if (!remarks) {
    throw new AppError('Remarks are required when resetting overtime plan status.', 400, 'RESET_REMARKS_REQUIRED');
  }

  return transaction(async (client) => {
    const plan = await getOvertimePlan(planId, {}, client);

    if (!plan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    if (actionByUser.role === 'supervisor') {
      const supervisorEmployee = await getEmployeeByUserId(actionByUser.id, client);

      if (!supervisorEmployee) {
        throw new AppError(
          'Your supervisor account is not linked to an employee profile.',
          403,
          'EMPLOYEE_PROFILE_REQUIRED'
        );
      }

      if (supervisorEmployee.departmentId !== plan.departmentId) {
        throw new AppError(
          'You can only reset overtime plans for your own department.',
          403,
          'RESET_STATUS_DEPARTMENT_MISMATCH'
        );
      }

      if (SUPERVISOR_PROTECTED_PLAN_STATUSES.includes(plan.status)) {
        throw new AppError(
          'Approved or closed overtime plans can only be reset by admin or HR.',
          403,
          'SUPERVISOR_FINAL_PLAN_RESET_DENIED'
        );
      }
    }

    if ((plan.planScope || 'employee') === 'department') {
      const actualPeriodReference = await client.query(
        `
          SELECT actual_period_id
          FROM overtime_actual_periods
          WHERE source_department_plan_id = $1
          LIMIT 1;
        `,
        [plan.planId]
      );

      if (actualPeriodReference.rows.length > 0) {
        throw new AppError(
          'This Department OT Plan already has linked Actual OT and cannot be reset. Use the Admin purge-data endpoint for permanent cleanup.',
          409,
          'PLAN_HAS_ACTUAL_OVERTIME'
        );
      }
    }

    const oldStatus = plan.status;
    const newStatus = normalizeResetStatus(resetData.newStatus || resetData.status, plan.planScope);

    if (oldStatus === newStatus) {
      throw new AppError('Overtime plan already has the requested status.', 400, 'PLAN_ALREADY_IN_RESET_STATUS');
    }

    if ((plan.planScope || 'employee') === 'employee') {
      const departmentPlanReference = await client.query(
        `
          SELECT opi.plan_id
          FROM overtime_plan_items opi
          WHERE opi.source_employee_plan_id = $1
          LIMIT 1;
        `,
        [plan.planId]
      );

      if (departmentPlanReference.rows.length > 0) {
        throw new AppError(
          'This employee overtime plan is already included in a Department OT Plan and cannot be reset.',
          409,
          'PLAN_INCLUDED_IN_DEPARTMENT_PLAN'
        );
      }
    }

    await client.query(
      `
        UPDATE overtime_plan_approvals
        SET status = 'skipped',
            acted_by = $2,
            acted_at = NOW(),
            remarks = $3
        WHERE plan_id = $1
          AND status = 'pending';
      `,
      [plan.planId, actionByUser.id, buildResetRemarks(oldStatus, newStatus, remarks)]
    );

    const updateParts = [
      'status = $2',
      'current_step_order = NULL',
      'current_approval_id = NULL',
      'current_approver_role = NULL',
      'current_approver_user_id = NULL',
      'approved_by = NULL',
      'approved_at = NULL',
      'closed_by = NULL',
      'closed_at = NULL',
      'updated_at = NOW()',
    ];
    const values = [plan.planId, newStatus];

    if (newStatus === 'draft') {
      updateParts.push('route_id = NULL');
      updateParts.push('submitted_by = NULL');
      updateParts.push('submitted_at = NULL');
      updateParts.push('department_submitted_by = NULL');
      updateParts.push('department_submitted_at = NULL');
      updateParts.push('supervisor_reviewed_by = NULL');
      updateParts.push('supervisor_reviewed_at = NULL');
      updateParts.push('rejected_by = NULL');
      updateParts.push('rejected_at = NULL');
      updateParts.push('rejection_reason = NULL');
    } else {
      values.push(actionByUser.id);
      updateParts.push(`rejected_by = $${values.length}`);
      updateParts.push('rejected_at = NOW()');
      values.push(remarks);
      updateParts.push(`rejection_reason = $${values.length}`);
    }

    if (newStatus === 'supervisor_returned') {
      updateParts.push('submitted_by = NULL');
      updateParts.push('submitted_at = NULL');
      updateParts.push('supervisor_reviewed_by = NULL');
      updateParts.push('supervisor_reviewed_at = NULL');
    }

    if (newStatus === 'returned_for_revision') {
      updateParts.push('department_submitted_by = NULL');
      updateParts.push('department_submitted_at = NULL');
    }

    await client.query(
      `
        UPDATE overtime_plans
        SET ${updateParts.join(', ')}
        WHERE plan_id = $1;
      `,
      values
    );

    if ((plan.planScope || 'employee') === 'employee') {
      await supersedeEmployeePlanSignatures(plan.planId, client);
    }

    await addPlanLog(
      plan.planId,
      actionByUser.role === 'supervisor' ? 'supervisor_status_reset' : 'admin_hr_status_reset',
      actionByUser.id,
      buildResetRemarks(oldStatus, newStatus, remarks),
      client
    );

    return getDepartmentPlanApprovalDetails(plan.planId, client);
  });
}

async function getPendingDepartmentPlanApprovalsForUser(user, filters = {}) {
  const clauses = [`op.status = 'pending_approval'`, `a.status = 'pending'`];
  const params = [];

  if (user.role !== 'admin') {
    if (user.role === 'hr') {
      clauses.push(`a.approver_role IN ('hr', 'admin')`);
    } else if (user.role === 'japanese_management') {
      params.push(user.id);
      const userParam = params.length;
      clauses.push(`a.approver_role = 'japanese_management'`);
      clauses.push(`a.approver_user_id = $${userParam}`);
    } else if (user.role === 'supervisor') {
      const employee = await getEmployeeByUserId(user.id);

      if (!employee) {
        throw new AppError('Your account is not linked to an employee profile.', 403, 'EMPLOYEE_PROFILE_REQUIRED');
      }

      params.push(employee.departmentId);
      const departmentParam = params.length;
      params.push(user.id);
      const userParam = params.length;
      clauses.push(`op.department_id = $${departmentParam}`);
      clauses.push(`a.approver_role = 'supervisor'`);
      clauses.push(`a.approver_user_id = $${userParam}`);
    } else {
      throw new AppError('You do not have pending department OT plan approval access.', 403, 'PENDING_APPROVAL_ACCESS_DENIED');
    }
  }

  const departmentId = normalize(filters.departmentId);
  const periodType = normalize(filters.periodType);

  if (departmentId) {
    params.push(departmentId);
    clauses.push(`op.department_id = $${params.length}`);
  }

  if (periodType) {
    params.push(normalizePeriodType(periodType));
    clauses.push(`op.period_type = $${params.length}`);
  }

  const result = await query(
    `
      SELECT
        a.*,
        u.first_name AS acted_by_first_name,
        u.middle_name AS acted_by_middle_name,
        u.last_name AS acted_by_last_name,
        op.department_id,
        d.department_name,
        op.period_type,
        op.period_start_date,
        op.period_end_date,
        op.status AS plan_status,
        op.plan_scope
      FROM overtime_plan_approvals a
      LEFT JOIN users u ON u.id = a.acted_by
      INNER JOIN overtime_plans op ON op.plan_id = a.plan_id
      LEFT JOIN departments d ON d.department_id = op.department_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY op.period_start_date ASC, a.step_order ASC, a.created_at ASC;
    `,
    params
  );

  return result.rows.map(mapPlanApproval);
}


module.exports = {
  addApprovalRouteAssignment,
  addApprovalRouteStep,
  approveDepartmentPlanStep,
  createApprovalRoute,
  createDepartmentPlanFromEmployeeDrafts,
  createSupervisorDepartmentPlanDraft,
  deleteApprovalRouteAssignment,
  deleteApprovalRouteStep,
  getActiveApprovalRouteForDepartment,
  getApprovalRoute,
  getApprovalRoutes,
  getDepartmentPlanApprovalDetails,
  getPendingDepartmentPlanApprovalsForUser,
  getSupervisorPlanDashboard,
  rejectDepartmentPlanStep,
  replaceSupervisorDepartmentPlanDraft,
  resetOvertimePlanStatus,
  setApprovalRouteStatus,
  startDepartmentPlanApproval,
  ensureEmployeePlanPeriodIsAvailable,
  submitEmployeePlanToSupervisor,
  submitEmployeePlanToSupervisorWithExecutor,
  supervisorReviewEmployeePlan,
};
