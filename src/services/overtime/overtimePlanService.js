const { query, transaction } = require('../../config/database');
const { getEmployeeById } = require('./employeeService');
const {
  buildFullName,
  dateOnly,
  iso,
  makeId,
  normalize,
  nullable,
  toNumber,
} = require('./shared/utils');
const AppError = require('../../utils/appError');
const notificationService = require('../notificationService');

const VALID_PLAN_STATUSES = ['draft', 'submitted', 'submitted_to_supervisor', 'supervisor_returned', 'supervisor_accepted', 'pending_approval', 'returned_for_revision', 'approved', 'rejected', 'closed'];
const VALID_PERIOD_TYPES = ['weekly', 'monthly'];
const BLOCKING_EMPLOYEE_PLAN_CREATION_STATUSES = [
  'submitted',
  'submitted_to_supervisor',
  'supervisor_returned',
  'supervisor_accepted',
  'pending_approval',
  'returned_for_revision',
  'approved',
  'closed',
];

function normalizePeriodType(value) {
  const periodType = normalize(value).toLowerCase();

  if (!VALID_PERIOD_TYPES.includes(periodType)) {
    throw new AppError('Period type must be weekly or monthly.', 400, 'INVALID_PLAN_PERIOD_TYPE');
  }

  return periodType;
}

function normalizePlanStatus(value) {
  const status = normalize(value).toLowerCase();

  if (!VALID_PLAN_STATUSES.includes(status)) {
    throw new AppError('Invalid overtime plan status.', 400, 'INVALID_PLAN_STATUS');
  }

  return status;
}

function normalizeDate(value, fieldName) {
  const normalized = normalize(value);

  if (!normalized || !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new AppError(`${fieldName} must use YYYY-MM-DD format.`, 400, 'INVALID_PLAN_DATE');
  }

  return normalized;
}

function normalizeOptionalDate(value, fieldName) {
  const normalized = normalize(value);

  if (!normalized) {
    return null;
  }

  return normalizeDate(normalized, fieldName);
}

function normalizeYear(value) {
  const normalized = normalize(value);

  if (!normalized) {
    return null;
  }

  const year = Number(normalized);

  if (!Number.isInteger(year) || year < 1900 || year > 3000) {
    throw new AppError('Year filter must be a valid year.', 400, 'INVALID_YEAR_FILTER');
  }

  return year;
}

function normalizeMonth(value) {
  const normalized = normalize(value);

  if (!normalized) {
    return null;
  }

  const month = Number(normalized);

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new AppError('Month filter must be from 1 to 12.', 400, 'INVALID_MONTH_FILTER');
  }

  return month;
}

function normalizeLimit(value) {
  const normalized = normalize(value);

  if (!normalized) {
    return null;
  }

  const limit = Number(normalized);

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new AppError('Limit must be a positive whole number.', 400, 'INVALID_LIMIT_FILTER');
  }

  return Math.min(limit, 100);
}

function normalizeOffset(value) {
  const normalized = normalize(value);

  if (!normalized) {
    return 0;
  }

  const offset = Number(normalized);

  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError('Offset must be zero or a positive whole number.', 400, 'INVALID_OFFSET_FILTER');
  }

  return offset;
}

function normalizePlannedHours(value) {
  const plannedHours = Number(value);

  if (!Number.isFinite(plannedHours) || plannedHours <= 0) {
    throw new AppError('Planned hours must be greater than zero.', 400, 'INVALID_PLANNED_HOURS');
  }

  return Math.round(plannedHours * 100) / 100;
}

function normalizeStatusFilter(status) {
  if (status === undefined || status === null || status === '') {
    return [];
  }

  const rawValues = Array.isArray(status) ? status : [status];
  const statuses = rawValues
    .flatMap((value) => String(value).split(','))
    .map((value) => normalize(value).toLowerCase())
    .filter(Boolean);

  const invalidStatus = statuses.find((value) => !VALID_PLAN_STATUSES.includes(value));

  if (invalidStatus) {
    throw new AppError(`Invalid overtime plan status filter: ${invalidStatus}.`, 400, 'INVALID_PLAN_STATUS_FILTER');
  }

  return [...new Set(statuses)];
}

function normalizePeriodTypeFilter(periodType) {
  if (periodType === undefined || periodType === null || periodType === '') {
    return null;
  }

  const normalized = normalize(periodType).toLowerCase();

  if (!VALID_PERIOD_TYPES.includes(normalized)) {
    throw new AppError('periodType filter must be weekly or monthly.', 400, 'INVALID_PERIOD_TYPE_FILTER');
  }

  return normalized;
}

function normalizePlanScopeFilter(planScope) {
  if (planScope === undefined || planScope === null || planScope === '') {
    return null;
  }

  const normalized = normalize(planScope).toLowerCase();

  if (!['employee', 'department'].includes(normalized)) {
    throw new AppError('planScope filter must be employee or department.', 400, 'INVALID_PLAN_SCOPE_FILTER');
  }

  return normalized;
}

function validatePlanDateRange(periodStartDate, periodEndDate) {
  if (periodStartDate > periodEndDate) {
    throw new AppError('Plan start date cannot be later than plan end date.', 400, 'INVALID_PLAN_DATE_RANGE');
  }
}

function parseDateOnly(value) {
  const [year, month, day] = normalizeDate(value, 'date').split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validatePlanPeriod(periodType, periodStartDate, periodEndDate) {
  validatePlanDateRange(periodStartDate, periodEndDate);

  const start = parseDateOnly(periodStartDate);
  const end = parseDateOnly(periodEndDate);

  if (periodType === 'weekly') {
    const expectedEnd = formatDateOnly(addUtcDays(start, 6));

    if (periodEndDate !== expectedEnd) {
      throw new AppError('Weekly overtime plans must cover exactly 7 calendar days.', 400, 'INVALID_WEEKLY_PLAN_PERIOD');
    }

    if (start.getUTCDay() !== 1) {
      throw new AppError('Weekly overtime plans must start on Monday and end on Sunday.', 400, 'INVALID_WEEKLY_PLAN_START');
    }

    return;
  }

  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth() + 1;
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth() + 1;

  if (startYear !== endYear || startMonth !== endMonth) {
    throw new AppError('Monthly overtime plans must stay within one calendar month.', 400, 'INVALID_MONTHLY_PLAN_PERIOD');
  }

  const expectedStart = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
  const expectedEnd = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(lastDayOfMonth(startYear, startMonth)).padStart(2, '0')}`;

  if (periodStartDate !== expectedStart || periodEndDate !== expectedEnd) {
    throw new AppError('Monthly overtime plans must cover the full calendar month.', 400, 'INVALID_MONTHLY_PLAN_RANGE');
  }
}

function ensureDraftPlan(plan) {
  if (!['draft', 'supervisor_returned', 'returned_for_revision'].includes(plan.status)) {
    throw new AppError('Only draft or returned overtime plans can be modified.', 400, 'PLAN_NOT_EDITABLE');
  }
}

function ensureItemDateWithinPlan(plan, plannedDate) {
  if (plannedDate < plan.periodStartDate || plannedDate > plan.periodEndDate) {
    throw new AppError('Planned date must be within the overtime plan period.', 400, 'PLAN_ITEM_DATE_OUT_OF_RANGE');
  }
}

function mapPlan(row) {
  const createdByName = buildFullName({
    firstName: row.created_by_first_name,
    middleName: row.created_by_middle_name,
    lastName: row.created_by_last_name,
  });

  const submittedByName = buildFullName({
    firstName: row.submitted_by_first_name,
    middleName: row.submitted_by_middle_name,
    lastName: row.submitted_by_last_name,
  });

  const approvedByName = buildFullName({
    firstName: row.approved_by_first_name,
    middleName: row.approved_by_middle_name,
    lastName: row.approved_by_last_name,
  });

  const rejectedByName = buildFullName({
    firstName: row.rejected_by_first_name,
    middleName: row.rejected_by_middle_name,
    lastName: row.rejected_by_last_name,
  });

  const closedByName = buildFullName({
    firstName: row.closed_by_first_name,
    middleName: row.closed_by_middle_name,
    lastName: row.closed_by_last_name,
  });

  return {
    planId: row.plan_id,
    departmentId: row.department_id,
    departmentName: row.department_name || '',
    periodType: row.period_type,
    periodStartDate: dateOnly(row.period_start_date),
    periodEndDate: dateOnly(row.period_end_date),
    status: row.status,
    planScope: row.plan_scope || 'employee',
    employeeSignaturesRequired: row.employee_signatures_required !== false,
    routeId: row.route_id || '',
    currentStepOrder: row.current_step_order || null,
    currentApprovalId: row.current_approval_id || '',
    currentApproverRole: row.current_approver_role || '',
    currentApproverUserId: row.current_approver_user_id || '',
    supervisorReviewedBy: row.supervisor_reviewed_by || '',
    supervisorReviewedAt: iso(row.supervisor_reviewed_at),
    departmentSubmittedBy: row.department_submitted_by || '',
    departmentSubmittedAt: iso(row.department_submitted_at),
    itemCount: toNumber(row.item_count),
    employeeCount: toNumber(row.employee_count),
    plannedHours: toNumber(row.planned_hours),
    createdBy: row.created_by,
    createdByName,
    submittedBy: row.submitted_by || '',
    submittedByName,
    submittedAt: iso(row.submitted_at),
    approvedBy: row.approved_by || '',
    approvedByName,
    approvedAt: iso(row.approved_at),
    rejectedBy: row.rejected_by || '',
    rejectedByName,
    rejectedAt: iso(row.rejected_at),
    closedBy: row.closed_by || '',
    closedByName,
    closedAt: iso(row.closed_at),
    remarks: row.remarks || '',
    rejectionReason: row.rejection_reason || '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapPlanItem(row) {
  const firstName = row.employee_first_name || '';
  const middleName = row.employee_middle_name || '';
  const lastName = row.employee_last_name || '';

  return {
    planItemId: row.plan_item_id,
    planId: row.plan_id,
    employeeId: row.employee_id,
    employeeUserId: row.employee_user_id || '',
    employeeNo: row.employee_no || '',
    employeeName: buildFullName({ firstName, middleName, lastName }),
    employeeEmail: row.employee_email || '',
    departmentId: row.department_id || '',
    departmentName: row.department_name || '',
    plannedDate: dateOnly(row.planned_date),
    plannedHours: toNumber(row.planned_hours),
    reason: row.reason || '',
    sourceEmployeePlanId: row.source_employee_plan_id || '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapPlanLog(row) {
  const firstName = row.action_by_first_name || '';
  const middleName = row.action_by_middle_name || '';
  const lastName = row.action_by_last_name || '';

  return {
    logId: row.log_id,
    planId: row.plan_id,
    action: row.action,
    actionBy: row.action_by,
    actionByName: buildFullName({ firstName, middleName, lastName }),
    actionAt: iso(row.action_at),
    remarks: row.remarks || '',
  };
}

const planSelect = `
  SELECT
    op.*,
    d.department_name,
    COALESCE(item_summary.item_count, 0)::INTEGER AS item_count,
    COALESCE(item_summary.employee_count, 0)::INTEGER AS employee_count,
    COALESCE(item_summary.planned_hours, 0)::NUMERIC AS planned_hours,
    created_by_user.first_name AS created_by_first_name,
    created_by_user.middle_name AS created_by_middle_name,
    created_by_user.last_name AS created_by_last_name,
    submitted_by_user.first_name AS submitted_by_first_name,
    submitted_by_user.middle_name AS submitted_by_middle_name,
    submitted_by_user.last_name AS submitted_by_last_name,
    approved_by_user.first_name AS approved_by_first_name,
    approved_by_user.middle_name AS approved_by_middle_name,
    approved_by_user.last_name AS approved_by_last_name,
    rejected_by_user.first_name AS rejected_by_first_name,
    rejected_by_user.middle_name AS rejected_by_middle_name,
    rejected_by_user.last_name AS rejected_by_last_name,
    closed_by_user.first_name AS closed_by_first_name,
    closed_by_user.middle_name AS closed_by_middle_name,
    closed_by_user.last_name AS closed_by_last_name
  FROM overtime_plans op
  INNER JOIN departments d ON d.department_id = op.department_id
  LEFT JOIN (
    SELECT
      plan_id,
      COUNT(*) AS item_count,
      COUNT(DISTINCT employee_id) AS employee_count,
      COALESCE(SUM(planned_hours), 0) AS planned_hours
    FROM overtime_plan_items
    GROUP BY plan_id
  ) item_summary ON item_summary.plan_id = op.plan_id
  LEFT JOIN users created_by_user ON created_by_user.id = op.created_by
  LEFT JOIN users submitted_by_user ON submitted_by_user.id = op.submitted_by
  LEFT JOIN users approved_by_user ON approved_by_user.id = op.approved_by
  LEFT JOIN users rejected_by_user ON rejected_by_user.id = op.rejected_by
  LEFT JOIN users closed_by_user ON closed_by_user.id = op.closed_by
`;

const itemSelect = `
  SELECT
    opi.*,
    e.user_id AS employee_user_id,
    e.employee_no,
    e.department_id,
    d.department_name,
    u.first_name AS employee_first_name,
    u.middle_name AS employee_middle_name,
    u.last_name AS employee_last_name,
    u.email AS employee_email
  FROM overtime_plan_items opi
  INNER JOIN employees e ON e.employee_id = opi.employee_id
  INNER JOIN users u ON u.id = e.user_id
  LEFT JOIN departments d ON d.department_id = e.department_id
`;

const logSelect = `
  SELECT
    opl.*,
    u.first_name AS action_by_first_name,
    u.middle_name AS action_by_middle_name,
    u.last_name AS action_by_last_name
  FROM overtime_plan_logs opl
  LEFT JOIN users u ON u.id = opl.action_by
`;

function buildPlanFilterClause(filters = {}) {
  const clauses = [];
  const params = [];
  const statuses = normalizeStatusFilter(filters.status);
  const periodType = normalizePeriodTypeFilter(filters.periodType);
  const departmentId = normalize(filters.departmentId);
  const employeeId = normalize(filters.employeeId);
  const userEmployeeId = normalize(filters.userEmployeeId);
  const userId = normalize(filters.userId);
  const userAccessibleEmployeeId = normalize(filters.userAccessibleEmployeeId);
  const dateFrom = normalizeOptionalDate(filters.dateFrom ?? filters.from ?? filters.startDate, 'dateFrom');
  const dateTo = normalizeOptionalDate(filters.dateTo ?? filters.to ?? filters.endDate, 'dateTo');
  const year = normalizeYear(filters.year);
  const month = normalizeMonth(filters.month);
  const planScope = normalizePlanScopeFilter(filters.planScope);
  const currentApproverRole = normalize(filters.currentApproverRole);
  const currentApproverUserId = normalize(filters.currentApproverUserId);
  const collapseFinalizedSources = filters.collapseFinalizedSources === true;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new AppError('dateFrom cannot be later than dateTo.', 400, 'INVALID_DATE_RANGE');
  }

  if (statuses.length > 0) {
    params.push(statuses);
    clauses.push(`op.status = ANY($${params.length})`);
  }

  if (periodType) {
    params.push(periodType);
    clauses.push(`op.period_type = $${params.length}`);
  }

  if (departmentId) {
    params.push(departmentId);
    clauses.push(`op.department_id = $${params.length}`);
  }

  if (planScope) {
    params.push(planScope);
    clauses.push(`COALESCE(op.plan_scope, 'employee') = $${params.length}`);
  }

  if (currentApproverRole) {
    params.push(currentApproverRole);
    const roleParam = params.length;

    if (currentApproverUserId) {
      params.push(currentApproverUserId);
      const userParam = params.length;
      clauses.push(`(
        op.current_approver_role = $${roleParam}
        AND (op.current_approver_user_id IS NULL OR op.current_approver_user_id = $${userParam})
      )`);
    } else {
      clauses.push(`op.current_approver_role = $${roleParam}`);
    }
  }

  if (dateFrom) {
    params.push(dateFrom);
    clauses.push(`op.period_end_date >= $${params.length}`);
  }

  if (dateTo) {
    params.push(dateTo);
    clauses.push(`op.period_start_date <= $${params.length}`);
  }

  if (year) {
    params.push(year);
    clauses.push(`(
      EXTRACT(YEAR FROM op.period_start_date)::INTEGER = $${params.length}
      OR EXTRACT(YEAR FROM op.period_end_date)::INTEGER = $${params.length}
    )`);
  }

  if (month) {
    params.push(month);
    clauses.push(`(
      EXTRACT(MONTH FROM op.period_start_date)::INTEGER = $${params.length}
      OR EXTRACT(MONTH FROM op.period_end_date)::INTEGER = $${params.length}
    )`);
  }

  if (employeeId || userEmployeeId) {
    params.push(employeeId || userEmployeeId);
    clauses.push(`EXISTS (
      SELECT 1
      FROM overtime_plan_items opi_filter
      WHERE opi_filter.plan_id = op.plan_id
        AND opi_filter.employee_id = $${params.length}
    )`);
  }

  if (userId && userAccessibleEmployeeId) {
    params.push(userId);
    const userIdParam = params.length;
    params.push(userAccessibleEmployeeId);
    const employeeIdParam = params.length;
    clauses.push(`(
      (
        COALESCE(op.plan_scope, 'employee') = 'employee'
        AND op.created_by = $${userIdParam}
      )
      OR (
        COALESCE(op.plan_scope, 'employee') = 'department'
        AND
        op.status IN ('approved', 'closed')
        AND EXISTS (
          SELECT 1
          FROM overtime_plan_items opi_access
          WHERE opi_access.plan_id = op.plan_id
            AND opi_access.employee_id = $${employeeIdParam}
        )
      )
    )`);
  }

  if (collapseFinalizedSources && userAccessibleEmployeeId) {
    params.push(userAccessibleEmployeeId);
    clauses.push(`NOT (
      COALESCE(op.plan_scope, 'employee') = 'employee'
      AND EXISTS (
        SELECT 1
        FROM overtime_plan_items canonical_item
        INNER JOIN overtime_plans canonical_plan
          ON canonical_plan.plan_id = canonical_item.plan_id
        WHERE canonical_item.source_employee_plan_id = op.plan_id
          AND canonical_item.employee_id = $${params.length}
          AND COALESCE(canonical_plan.plan_scope, 'employee') = 'department'
          AND canonical_plan.status IN ('approved', 'closed')
      )
    )`);
  }

  return {
    whereClause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

async function addPlanLog(planId, action, actionBy, remarks, executor = { query }) {
  const normalizedPlanId = normalize(planId);
  const normalizedActionBy = normalize(actionBy);
  const normalizedRemarks = nullable(remarks);
  const result = await executor.query(
    `
      INSERT INTO overtime_plan_logs (log_id, plan_id, action, action_by, remarks)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING log_id;
    `,
    [makeId('PLANLOG'), normalizedPlanId, action, normalizedActionBy, normalizedRemarks]
  );

  const log = result.rows[0];

  await notificationService.createPlanLogNotifications({
    planId: normalizedPlanId,
    logId: log.log_id,
    action,
    actionBy: normalizedActionBy,
    remarks: normalizedRemarks,
  }, executor);

  return log;
}

async function getOvertimePlan(planId, options = {}, executor = { query }) {
  const result = await executor.query(
    `
      ${planSelect}
      WHERE op.plan_id = $1
      LIMIT 1;
    `,
    [normalize(planId)]
  );

  const plan = result.rows[0] ? mapPlan(result.rows[0]) : null;

  if (!plan) {
    return null;
  }

  let itemWhere = 'WHERE opi.plan_id = $1';
  const itemParams = [plan.planId];

  if (options.userEmployeeId) {
    itemParams.push(normalize(options.userEmployeeId));
    itemWhere += ` AND opi.employee_id = $${itemParams.length}`;
  }

  const itemResult = await executor.query(
    `
      ${itemSelect}
      ${itemWhere}
      ORDER BY opi.planned_date ASC, u.last_name ASC, u.first_name ASC;
    `,
    itemParams
  );

  const logResult = await executor.query(
    `
      ${logSelect}
      WHERE opl.plan_id = $1
      ORDER BY opl.action_at ASC;
    `,
    [plan.planId]
  );

  return {
    ...plan,
    items: itemResult.rows.map(mapPlanItem),
    logs: logResult.rows.map(mapPlanLog),
  };
}

function buildEmployeePlanWorkflowProgress(plan, departmentPlan = null) {
  const employeeStatus = plan.status;
  const supervisorCompleted = [
    'supervisor_accepted',
    'pending_approval',
    'approved',
    'closed',
  ].includes(employeeStatus) || Boolean(departmentPlan);
  const supervisorNeedsAction = [
    'supervisor_returned',
    'returned_for_revision',
    'rejected',
  ].includes(employeeStatus);
  const supervisorInProgress = ['submitted', 'submitted_to_supervisor'].includes(employeeStatus);
  const departmentStatus = departmentPlan?.status || '';
  const finalCompleted = ['approved', 'closed'].includes(departmentStatus);
  const finalNeedsAction = ['rejected', 'returned_for_revision'].includes(departmentStatus);
  const finalInProgress = Boolean(departmentPlan) && !finalCompleted && !finalNeedsAction;
  const currentApprover = normalize(departmentPlan?.currentApproverRole)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

  const stages = [
    {
      key: 'draft_created',
      label: 'Plan created',
      state: 'completed',
      detail: 'Your employee overtime plan was created.',
      completedAt: plan.createdAt || null,
    },
    {
      key: 'supervisor_review',
      label: 'Supervisor review',
      state: supervisorCompleted
        ? 'completed'
        : supervisorNeedsAction
          ? 'action_required'
          : supervisorInProgress
            ? 'current'
            : 'pending',
      detail: supervisorCompleted
        ? 'Your supervisor accepted the employee plan.'
        : supervisorNeedsAction
          ? 'Changes are required before this plan can continue.'
          : supervisorInProgress
            ? 'Waiting for your supervisor to review the plan.'
            : 'Submit the completed draft to your supervisor.',
      completedAt: supervisorCompleted ? plan.supervisorReviewedAt || null : null,
    },
    {
      key: 'department_consolidation',
      label: 'Department consolidation',
      state: departmentPlan
        ? 'completed'
        : supervisorCompleted
          ? 'current'
          : 'pending',
      detail: departmentPlan
        ? 'Your overtime entries were included in the department plan.'
        : supervisorCompleted
          ? 'Waiting for the supervisor to prepare the department plan.'
          : 'Available after supervisor acceptance.',
      completedAt: departmentPlan?.createdAt || null,
    },
    {
      key: 'final_approval',
      label: 'Department approval',
      state: finalCompleted
        ? 'completed'
        : finalNeedsAction
          ? 'action_required'
          : finalInProgress
            ? 'current'
            : 'pending',
      detail: finalCompleted
        ? 'The department overtime plan received final approval.'
        : finalNeedsAction
          ? 'The department plan was returned for correction.'
          : finalInProgress
            ? currentApprover
              ? `Waiting for ${currentApprover} approval.`
              : 'The department plan is being prepared for approval.'
            : 'Available after department consolidation.',
      completedAt: finalCompleted
        ? departmentPlan.approvedAt || departmentPlan.closedAt || null
        : null,
    },
  ];

  return {
    departmentPlanStatus: departmentStatus,
    stages,
  };
}

async function getEmployeePlanWorkflowProgress(plan, executor = { query }) {
  if (!plan || (plan.planScope || 'employee') !== 'employee') {
    return null;
  }

  const result = await executor.query(
    `
      SELECT DISTINCT
        department_plan.status,
        department_plan.current_approver_role,
        department_plan.created_at,
        department_plan.approved_at,
        department_plan.closed_at
      FROM overtime_plan_items department_item
      INNER JOIN overtime_plans department_plan
        ON department_plan.plan_id = department_item.plan_id
      WHERE department_item.source_employee_plan_id = $1
        AND COALESCE(department_plan.plan_scope, 'employee') = 'department'
      ORDER BY department_plan.created_at DESC
      LIMIT 1;
    `,
    [plan.planId]
  );
  const row = result.rows[0];
  const departmentPlan = row
    ? {
        status: row.status,
        currentApproverRole: row.current_approver_role || '',
        createdAt: iso(row.created_at),
        approvedAt: iso(row.approved_at),
        closedAt: iso(row.closed_at),
      }
    : null;

  return buildEmployeePlanWorkflowProgress(plan, departmentPlan);
}

async function getOvertimePlans(filters = {}, executor = { query }) {
  const { whereClause, params } = buildPlanFilterClause(filters);
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);
  let limitOffsetClause = '';

  if (limit) {
    params.push(limit);
    limitOffsetClause += ` LIMIT $${params.length}`;
  }

  if (offset) {
    params.push(offset);
    limitOffsetClause += ` OFFSET $${params.length}`;
  }

  const result = await executor.query(
    `
      ${planSelect}
      ${whereClause}
      ORDER BY op.period_start_date DESC, op.created_at DESC
      ${limitOffsetClause};
    `,
    params
  );

  const plans = result.rows.map(mapPlan);
  const userSummaryEmployeeId = filters.userEmployeeId || filters.userAccessibleEmployeeId;

  if (userSummaryEmployeeId && plans.length > 0) {
    const planIds = plans.map((plan) => plan.planId);
    const summaryResult = await executor.query(
      `
        SELECT
          plan_id,
          COUNT(*)::INTEGER AS item_count,
          COALESCE(SUM(planned_hours), 0)::NUMERIC AS planned_hours
        FROM overtime_plan_items
        WHERE employee_id = $1
          AND plan_id = ANY($2)
        GROUP BY plan_id;
      `,
      [normalize(userSummaryEmployeeId), planIds]
    );

    const summaryByPlanId = new Map(summaryResult.rows.map((row) => [
      row.plan_id,
      {
        itemCount: toNumber(row.item_count),
        plannedHours: toNumber(row.planned_hours),
      },
    ]));

    return plans.map((plan) => {
      if (filters.userAccessibleEmployeeId && filters.userId && plan.createdBy === normalize(filters.userId)) {
        return plan;
      }

      return {
        ...plan,
        itemCount: summaryByPlanId.get(plan.planId)?.itemCount || 0,
        plannedHours: summaryByPlanId.get(plan.planId)?.plannedHours || 0,
      };
    });
  }

  return plans;
}

function buildPlanItemFilterClause(filters = {}) {
  const clauses = [];
  const params = [];
  const statuses = normalizeStatusFilter(filters.status);
  const periodType = normalizePeriodTypeFilter(filters.periodType);
  const planScope = normalizePlanScopeFilter(filters.planScope);
  const departmentId = normalize(filters.departmentId);
  const employeeId = normalize(filters.employeeId || filters.userEmployeeId || filters.userAccessibleEmployeeId);
  const planId = normalize(filters.planId);
  const dateFrom = normalizeOptionalDate(filters.dateFrom ?? filters.from ?? filters.startDate, 'dateFrom');
  const dateTo = normalizeOptionalDate(filters.dateTo ?? filters.to ?? filters.endDate, 'dateTo');
  const year = normalizeYear(filters.year);
  const month = normalizeMonth(filters.month);
  const currentApproverRole = normalize(filters.currentApproverRole);
  const currentApproverUserId = normalize(filters.currentApproverUserId);
  const createdBy = normalize(filters.createdBy || filters.userId);
  const approvedOnly = filters.approvedOnly === true || normalize(filters.approvedOnly).toLowerCase() === 'true';
  const collapseFinalizedSources = filters.collapseFinalizedSources === true;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new AppError('dateFrom cannot be later than dateTo.', 400, 'INVALID_DATE_RANGE');
  }

  if (statuses.length > 0) {
    params.push(statuses);
    clauses.push(`op.status = ANY($${params.length})`);
  }

  if (periodType) {
    params.push(periodType);
    clauses.push(`op.period_type = $${params.length}`);
  }

  if (planScope) {
    params.push(planScope);
    clauses.push(`COALESCE(op.plan_scope, 'employee') = $${params.length}`);
  }

  if (departmentId) {
    params.push(departmentId);
    clauses.push(`op.department_id = $${params.length}`);
  }

  if (employeeId) {
    params.push(employeeId);
    clauses.push(`opi.employee_id = $${params.length}`);
  }

  if (planId) {
    params.push(planId);
    clauses.push(`opi.plan_id = $${params.length}`);
  }

  if (createdBy) {
    params.push(createdBy);
    clauses.push(`op.created_by = $${params.length}`);
  }

  if (approvedOnly) {
    clauses.push(`op.status = 'approved'`);
  }

  if (collapseFinalizedSources && employeeId) {
    clauses.push(`(
      COALESCE(op.plan_scope, 'employee') = 'employee'
      OR (
        COALESCE(op.plan_scope, 'employee') = 'department'
        AND op.status IN ('approved', 'closed')
      )
    )`);

    clauses.push(`NOT (
      COALESCE(op.plan_scope, 'employee') = 'employee'
      AND EXISTS (
        SELECT 1
        FROM overtime_plan_items canonical_item
        INNER JOIN overtime_plans canonical_plan
          ON canonical_plan.plan_id = canonical_item.plan_id
        WHERE canonical_item.source_employee_plan_id = op.plan_id
          AND canonical_item.employee_id = opi.employee_id
          AND canonical_item.planned_date = opi.planned_date
          AND COALESCE(canonical_plan.plan_scope, 'employee') = 'department'
          AND canonical_plan.status IN ('approved', 'closed')
      )
    )`);
  }

  if (currentApproverRole) {
    params.push(currentApproverRole);
    const roleParam = params.length;

    if (currentApproverUserId) {
      params.push(currentApproverUserId);
      const userParam = params.length;
      clauses.push(`(
        op.current_approver_role = $${roleParam}
        AND (op.current_approver_user_id IS NULL OR op.current_approver_user_id = $${userParam})
      )`);
    } else {
      clauses.push(`op.current_approver_role = $${roleParam}`);
    }
  }

  if (dateFrom) {
    params.push(dateFrom);
    clauses.push(`opi.planned_date >= $${params.length}`);
  }

  if (dateTo) {
    params.push(dateTo);
    clauses.push(`opi.planned_date <= $${params.length}`);
  }

  if (year) {
    params.push(year);
    clauses.push(`EXTRACT(YEAR FROM opi.planned_date)::INTEGER = $${params.length}`);
  }

  if (month) {
    params.push(month);
    clauses.push(`EXTRACT(MONTH FROM opi.planned_date)::INTEGER = $${params.length}`);
  }

  return {
    whereClause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function mapPlanItemListRow(row) {
  return {
    ...mapPlanItem(row),
    planStatus: row.plan_status,
    planScope: row.plan_scope || 'employee',
    periodType: row.period_type,
    periodStartDate: dateOnly(row.period_start_date),
    periodEndDate: dateOnly(row.period_end_date),
    createdBy: row.plan_created_by || '',
    currentApproverRole: row.current_approver_role || '',
    currentApproverUserId: row.current_approver_user_id || '',
  };
}

async function getOvertimePlanItems(filters = {}) {
  const { whereClause, params } = buildPlanItemFilterClause(filters);
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);
  let limitOffsetClause = '';

  if (limit) {
    params.push(limit);
    limitOffsetClause += ` LIMIT $${params.length}`;
  }

  if (offset) {
    params.push(offset);
    limitOffsetClause += ` OFFSET $${params.length}`;
  }

  const result = await query(
    `
      SELECT
        opi.*,
        e.user_id AS employee_user_id,
        e.employee_no,
        e.department_id,
        d.department_name,
        u.first_name AS employee_first_name,
        u.middle_name AS employee_middle_name,
        u.last_name AS employee_last_name,
        u.email AS employee_email,
        op.status AS plan_status,
        op.plan_scope,
        op.period_type,
        op.period_start_date,
        op.period_end_date,
        op.created_by AS plan_created_by,
        op.current_approver_role,
        op.current_approver_user_id
      FROM overtime_plan_items opi
      INNER JOIN overtime_plans op ON op.plan_id = opi.plan_id
      INNER JOIN employees e ON e.employee_id = opi.employee_id
      INNER JOIN users u ON u.id = e.user_id
      LEFT JOIN departments d ON d.department_id = e.department_id
      ${whereClause}
      ORDER BY opi.planned_date ASC, d.department_name ASC, u.last_name ASC, u.first_name ASC
      ${limitOffsetClause};
    `,
    params
  );

  return result.rows.map(mapPlanItemListRow);
}

async function getOvertimePlanCalendarSummary(filters = {}, executor = { query }) {
  const { whereClause, params } = buildPlanItemFilterClause(filters);

  const result = await executor.query(
    `
      SELECT
        opi.planned_date,
        COUNT(*)::INTEGER AS item_count,
        COUNT(DISTINCT opi.employee_id)::INTEGER AS employee_count,
        COUNT(DISTINCT opi.plan_id)::INTEGER AS plan_count,
        COALESCE(SUM(opi.planned_hours), 0)::NUMERIC AS planned_hours,
        ARRAY_AGG(DISTINCT op.status ORDER BY op.status) AS statuses
      FROM overtime_plan_items opi
      INNER JOIN overtime_plans op ON op.plan_id = opi.plan_id
      INNER JOIN employees e ON e.employee_id = opi.employee_id
      ${whereClause}
      GROUP BY opi.planned_date
      ORDER BY opi.planned_date ASC;
    `,
    params
  );

  return result.rows.map((row) => ({
    date: dateOnly(row.planned_date),
    itemCount: toNumber(row.item_count),
    employeeCount: toNumber(row.employee_count),
    planCount: toNumber(row.plan_count),
    plannedHours: toNumber(row.planned_hours),
    statuses: Array.isArray(row.statuses) ? row.statuses : [],
  }));
}

async function ensureEmployeePlanCreationPeriodIsAvailable(planData, createdBy, executor = { query }, excludePlanId = '') {
  const lockKey = [
    'employee-plan-submit',
    planData.departmentId,
    planData.periodType,
    planData.periodStartDate,
    planData.periodEndDate,
  ].join(':');

  await executor.query(
    'SELECT pg_advisory_xact_lock(hashtext($1)::BIGINT);',
    [lockKey]
  );

  const existingPlanResult = await executor.query(
    `
      SELECT plan_id, status
      FROM overtime_plans
      WHERE department_id = $1
        AND COALESCE(plan_scope, 'employee') = 'employee'
        AND created_by = $2
        AND period_type = $3
        AND period_start_date = $4
        AND period_end_date = $5
        AND status = ANY($6::TEXT[])
        AND ($7::TEXT = '' OR plan_id <> $7)
      LIMIT 1;
    `,
    [
      planData.departmentId,
      normalize(createdBy),
      planData.periodType,
      planData.periodStartDate,
      planData.periodEndDate,
      BLOCKING_EMPLOYEE_PLAN_CREATION_STATUSES,
      normalize(excludePlanId),
    ]
  );

  if (existingPlanResult.rows.length > 0) {
    throw new AppError(
      'An employee overtime plan for this period is already submitted or still in workflow. Another draft cannot be created.',
      409,
      'DUPLICATE_ACTIVE_EMPLOYEE_PLAN'
    );
  }
}

async function createOvertimePlanInTransaction(planData, createdBy, client) {
  const departmentId = normalize(planData.departmentId);
  const periodType = normalizePeriodType(planData.periodType);
  const periodStartDate = normalizeDate(planData.periodStartDate, 'periodStartDate');
  const periodEndDate = normalizeDate(planData.periodEndDate, 'periodEndDate');
  const planScope = normalize(planData.planScope || 'employee').toLowerCase();

  if (!['employee', 'department'].includes(planScope)) {
    throw new AppError('Plan scope must be employee or department.', 400, 'INVALID_PLAN_SCOPE');
  }

  validatePlanPeriod(periodType, periodStartDate, periodEndDate);

  if (!departmentId) {
    throw new AppError('Department ID is required.', 400, 'DEPARTMENT_REQUIRED');
  }

  const departmentResult = await client.query(
      'SELECT department_id FROM departments WHERE department_id = $1 LIMIT 1;',
      [departmentId]
    );

    if (departmentResult.rows.length === 0) {
      throw new AppError('Department not found.', 404, 'DEPARTMENT_NOT_FOUND');
    }

    if (planScope === 'employee') {
      await ensureEmployeePlanCreationPeriodIsAvailable(
        {
          departmentId,
          periodType,
          periodStartDate,
          periodEndDate,
        },
        createdBy,
        client
      );
    }

    const result = await client.query(
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
        VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8)
        RETURNING plan_id;
      `,
      [
        makeId('PLAN'),
        departmentId,
        periodType,
        periodStartDate,
        periodEndDate,
        planScope,
        normalize(createdBy),
        nullable(planData.remarks),
      ]
    );

    await addPlanLog(result.rows[0].plan_id, 'created', createdBy, 'Overtime plan created.', client);
  return getOvertimePlan(result.rows[0].plan_id, {}, client);
}

async function createOvertimePlan(planData, createdBy) {
  return transaction((client) => createOvertimePlanInTransaction(planData, createdBy, client));
}

function normalizeEmployeeDraftItems(items, plan, employeeId) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError('Select at least one overtime entry for the draft.', 400, 'PLAN_ITEMS_REQUIRED');
  }

  if (items.length > 100) {
    throw new AppError('A maximum of 100 plan items can be saved at a time.', 400, 'PLAN_ITEMS_LIMIT_EXCEEDED');
  }

  const normalizedEmployeeId = normalize(employeeId);
  const seenDates = new Set();

  return items.map((itemData) => {
    const plannedDate = normalizeDate(itemData.plannedDate ?? itemData.date, 'plannedDate');
    const plannedHours = normalizePlannedHours(itemData.plannedHours ?? itemData.totalHours);
    const reason = normalize(itemData.reason);

    if (!reason) {
      throw new AppError('Reason is required for every plan item.', 400, 'PLAN_ITEM_REQUIRED_FIELDS');
    }

    ensureItemDateWithinPlan(plan, plannedDate);

    if (seenDates.has(plannedDate)) {
      throw new AppError('Duplicate date found in submitted plan items.', 409, 'DUPLICATE_PLAN_ITEM_IN_REQUEST');
    }

    seenDates.add(plannedDate);
    return {
      employeeId: normalizedEmployeeId,
      plannedDate,
      plannedHours,
      reason,
    };
  });
}

async function replaceEmployeeDraftItems(plan, items, employeeId, client) {
  const employee = await getEmployeeById(employeeId, client);

  if (!employee) {
    throw new AppError('Employee not found.', 404, 'EMPLOYEE_NOT_FOUND');
  }

  if (employee.departmentId !== plan.departmentId) {
    throw new AppError('Employee must belong to the overtime plan department.', 400, 'PLAN_EMPLOYEE_DEPARTMENT_MISMATCH');
  }

  const normalizedItems = normalizeEmployeeDraftItems(items, plan, employee.employeeId);
  await client.query('DELETE FROM overtime_plan_items WHERE plan_id = $1;', [plan.planId]);

  for (const item of normalizedItems) {
    await client.query(
      `
        INSERT INTO overtime_plan_items (
          plan_item_id,
          plan_id,
          employee_id,
          planned_date,
          planned_hours,
          reason
        )
        VALUES ($1, $2, $3, $4, $5, $6);
      `,
      [
        makeId('PLANITEM'),
        plan.planId,
        item.employeeId,
        item.plannedDate,
        item.plannedHours,
        item.reason,
      ]
    );
  }

  return normalizedItems.length;
}

async function createEmployeeOvertimePlanDraft(planData, items, employeeId, createdBy) {
  return transaction(async (client) => {
    const plan = await createOvertimePlanInTransaction(
      { ...planData, planScope: 'employee' },
      createdBy,
      client
    );
    const itemCount = await replaceEmployeeDraftItems(plan, items, employeeId, client);

    await client.query(
      'UPDATE overtime_plans SET updated_at = NOW() WHERE plan_id = $1;',
      [plan.planId]
    );
    await addPlanLog(
      plan.planId,
      'draft_saved',
      createdBy,
      `Employee draft saved with ${itemCount} overtime entr${itemCount === 1 ? 'y' : 'ies'}.`,
      client
    );

    return getOvertimePlan(plan.planId, {}, client);
  });
}

async function replaceEmployeeOvertimePlanDraft(planId, draftData, employeeId, updatedBy) {
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
      throw new AppError('expectedUpdatedAt must contain the plan version being edited.', 400, 'PLAN_VERSION_REQUIRED');
    }

    const currentUpdatedAt = new Date(lockResult.rows[0].updated_at).toISOString();

    if (new Date(expectedUpdatedAt).toISOString() !== currentUpdatedAt) {
      throw new AppError(
        'This overtime plan changed after you opened it. Reload the latest version before saving.',
        409,
        'PLAN_VERSION_CONFLICT'
      );
    }

    const existingPlan = await getOvertimePlan(planId, {}, client);
    ensureDraftPlan(existingPlan);

    if ((existingPlan.planScope || 'employee') !== 'employee' || existingPlan.createdBy !== normalize(updatedBy)) {
      throw new AppError('You can only replace your own employee overtime draft.', 403, 'PLAN_DRAFT_ACCESS_DENIED');
    }

    const periodType = normalizePeriodType(draftData.periodType ?? existingPlan.periodType);
    const periodStartDate = normalizeDate(
      draftData.periodStartDate ?? existingPlan.periodStartDate,
      'periodStartDate'
    );
    const periodEndDate = normalizeDate(
      draftData.periodEndDate ?? existingPlan.periodEndDate,
      'periodEndDate'
    );
    validatePlanPeriod(periodType, periodStartDate, periodEndDate);

    await ensureEmployeePlanCreationPeriodIsAvailable(
      {
        departmentId: existingPlan.departmentId,
        periodType,
        periodStartDate,
        periodEndDate,
      },
      updatedBy,
      client,
      existingPlan.planId
    );

    const replacementPlan = {
      ...existingPlan,
      periodType,
      periodStartDate,
      periodEndDate,
    };
    const itemCount = await replaceEmployeeDraftItems(
      replacementPlan,
      draftData.items,
      employeeId,
      client
    );

    await client.query(
      `
        UPDATE overtime_plans
        SET period_type = $2,
            period_start_date = $3,
            period_end_date = $4,
            remarks = $5,
            updated_at = NOW()
        WHERE plan_id = $1;
      `,
      [
        existingPlan.planId,
        periodType,
        periodStartDate,
        periodEndDate,
        nullable(draftData.remarks),
      ]
    );
    await addPlanLog(
      existingPlan.planId,
      'draft_saved',
      updatedBy,
      `Employee draft saved with ${itemCount} overtime entr${itemCount === 1 ? 'y' : 'ies'}.`,
      client
    );

    return getOvertimePlan(existingPlan.planId, {}, client);
  });
}

async function updateOvertimePlan(planId, updates) {
  return transaction(async (client) => {
    const existingPlan = await getOvertimePlan(planId, {}, client);

    if (!existingPlan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    ensureDraftPlan(existingPlan);

    const fields = [];
    const values = [existingPlan.planId];

    function addField(column, value) {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    }

    const nextPeriodType = Object.prototype.hasOwnProperty.call(updates, 'periodType')
      ? normalizePeriodType(updates.periodType)
      : existingPlan.periodType;
    const nextStartDate = Object.prototype.hasOwnProperty.call(updates, 'periodStartDate')
      ? normalizeDate(updates.periodStartDate, 'periodStartDate')
      : existingPlan.periodStartDate;
    const nextEndDate = Object.prototype.hasOwnProperty.call(updates, 'periodEndDate')
      ? normalizeDate(updates.periodEndDate, 'periodEndDate')
      : existingPlan.periodEndDate;

    validatePlanPeriod(nextPeriodType, nextStartDate, nextEndDate);

    if (Object.prototype.hasOwnProperty.call(updates, 'departmentId')) {
      const departmentId = normalize(updates.departmentId);

      if (!departmentId) {
        throw new AppError('Department ID cannot be empty.', 400, 'DEPARTMENT_REQUIRED');
      }

      const departmentResult = await client.query(
        'SELECT department_id FROM departments WHERE department_id = $1 LIMIT 1;',
        [departmentId]
      );

      if (departmentResult.rows.length === 0) {
        throw new AppError('Department not found.', 404, 'DEPARTMENT_NOT_FOUND');
      }

      const itemDepartmentResult = await client.query(
        `
          SELECT COUNT(*)::INTEGER AS mismatch_count
          FROM overtime_plan_items opi
          INNER JOIN employees e ON e.employee_id = opi.employee_id
          WHERE opi.plan_id = $1
            AND e.department_id <> $2;
        `,
        [existingPlan.planId, departmentId]
      );

      if (toNumber(itemDepartmentResult.rows[0].mismatch_count) > 0) {
        throw new AppError(
          'Cannot change plan department while plan items contain employees from another department.',
          400,
          'PLAN_ITEM_DEPARTMENT_MISMATCH'
        );
      }

      addField('department_id', departmentId);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'periodType')) {
      addField('period_type', nextPeriodType);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'periodStartDate')) {
      addField('period_start_date', nextStartDate);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'periodEndDate')) {
      addField('period_end_date', nextEndDate);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'remarks')) {
      addField('remarks', nullable(updates.remarks));
    }

    if (fields.length === 0) {
      return existingPlan;
    }

    fields.push('updated_at = NOW()');

    await client.query(
      `
        UPDATE overtime_plans
        SET ${fields.join(', ')}
        WHERE plan_id = $1;
      `,
      values
    );

    await addPlanLog(existingPlan.planId, 'updated', updates.updatedBy, 'Overtime plan updated.', client);
    return getOvertimePlan(existingPlan.planId, {}, client);
  });
}

async function deleteOvertimePlan(planId) {
  return transaction(async (client) => {
    const existingPlan = await getOvertimePlan(planId, {}, client);

    if (!existingPlan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    if (!['draft', 'rejected', 'supervisor_returned', 'returned_for_revision'].includes(existingPlan.status)) {
      throw new AppError('Only draft, returned, or rejected overtime plans can be deleted.', 400, 'PLAN_DELETE_NOT_ALLOWED');
    }

    await client.query('DELETE FROM overtime_plans WHERE plan_id = $1;', [existingPlan.planId]);
    return existingPlan;
  });
}

async function changeOvertimePlanStatus(planId, nextStatus, actionBy, remarks) {
  const normalizedNextStatus = normalizePlanStatus(nextStatus);

  return transaction(async (client) => {
    const existingPlan = await getOvertimePlan(planId, {}, client);

    if (!existingPlan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    const transitions = {
      draft: ['submitted', 'submitted_to_supervisor', 'pending_approval'],
      supervisor_returned: ['submitted_to_supervisor'],
      submitted_to_supervisor: ['supervisor_accepted', 'supervisor_returned'],
      supervisor_accepted: ['pending_approval'],
      pending_approval: ['approved', 'rejected', 'returned_for_revision'],
      returned_for_revision: ['pending_approval'],
      submitted: ['approved', 'rejected'],
      approved: ['closed'],
      rejected: [],
      closed: [],
    };

    if (!transitions[existingPlan.status].includes(normalizedNextStatus)) {
      throw new AppError(
        `Cannot change overtime plan status from ${existingPlan.status} to ${normalizedNextStatus}.`,
        400,
        'INVALID_PLAN_STATUS_TRANSITION'
      );
    }

    if (normalizedNextStatus === 'submitted' && existingPlan.itemCount === 0) {
      throw new AppError('Add at least one plan item before submitting the overtime plan.', 400, 'PLAN_HAS_NO_ITEMS');
    }

    const updateParts = [
      'status = $2',
      'updated_at = NOW()',
    ];
    const values = [existingPlan.planId, normalizedNextStatus];

    if (normalizedNextStatus === 'submitted') {
      values.push(normalize(actionBy));
      updateParts.push(`submitted_by = $${values.length}`);
      updateParts.push('submitted_at = NOW()');
    }

    if (normalizedNextStatus === 'approved') {
      values.push(normalize(actionBy));
      updateParts.push(`approved_by = $${values.length}`);
      updateParts.push('approved_at = NOW()');
      updateParts.push('rejected_by = NULL');
      updateParts.push('rejected_at = NULL');
      updateParts.push('rejection_reason = NULL');
    }

    if (normalizedNextStatus === 'rejected') {
      values.push(normalize(actionBy));
      updateParts.push(`rejected_by = $${values.length}`);
      updateParts.push('rejected_at = NOW()');
      values.push(nullable(remarks));
      updateParts.push(`rejection_reason = $${values.length}`);
    }

    if (normalizedNextStatus === 'closed') {
      values.push(normalize(actionBy));
      updateParts.push(`closed_by = $${values.length}`);
      updateParts.push('closed_at = NOW()');
    }

    await client.query(
      `
        UPDATE overtime_plans
        SET ${updateParts.join(', ')}
        WHERE plan_id = $1;
      `,
      values
    );

    await addPlanLog(existingPlan.planId, normalizedNextStatus, actionBy, remarks || `Overtime plan ${normalizedNextStatus}.`, client);
    return getOvertimePlan(existingPlan.planId, {}, client);
  });
}

async function addOvertimePlanItem(planId, itemData, createdBy) {
  return transaction(async (client) => {
    const plan = await getOvertimePlan(planId, {}, client);

    if (!plan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    ensureDraftPlan(plan);

    const employeeId = normalize(itemData.employeeId);
    const plannedDate = normalizeDate(itemData.plannedDate ?? itemData.date, 'plannedDate');
    const plannedHours = normalizePlannedHours(itemData.plannedHours ?? itemData.totalHours);
    const reason = normalize(itemData.reason);

    if (!employeeId || !reason) {
      throw new AppError('Employee ID and reason are required.', 400, 'PLAN_ITEM_REQUIRED_FIELDS');
    }

    ensureItemDateWithinPlan(plan, plannedDate);

    const employee = await getEmployeeById(employeeId, client);

    if (!employee) {
      throw new AppError('Employee not found.', 404, 'EMPLOYEE_NOT_FOUND');
    }

    if (employee.departmentId !== plan.departmentId) {
      throw new AppError('Employee must belong to the overtime plan department.', 400, 'PLAN_EMPLOYEE_DEPARTMENT_MISMATCH');
    }

    let result;

    try {
      result = await client.query(
        `
          INSERT INTO overtime_plan_items (
            plan_item_id,
            plan_id,
            employee_id,
            planned_date,
            planned_hours,
            reason
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING plan_item_id;
        `,
        [makeId('PLANITEM'), plan.planId, employeeId, plannedDate, plannedHours, reason]
      );
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError('This employee already has planned overtime on this date for this plan.', 409, 'DUPLICATE_PLAN_ITEM');
      }

      throw error;
    }

    await addPlanLog(plan.planId, 'item_added', createdBy, `Plan item added for ${plannedDate}.`, client);
    const item = await getOvertimePlanItem(result.rows[0].plan_item_id, client);

    return {
      plan: await getOvertimePlan(plan.planId, {}, client),
      item,
    };
  });
}

async function addOvertimePlanItems(planId, items, createdBy) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError('items must be a non-empty array.', 400, 'PLAN_ITEMS_REQUIRED');
  }

  if (items.length > 100) {
    throw new AppError('A maximum of 100 plan items can be added at a time.', 400, 'PLAN_ITEMS_LIMIT_EXCEEDED');
  }

  return transaction(async (client) => {
    const plan = await getOvertimePlan(planId, {}, client);

    if (!plan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    ensureDraftPlan(plan);

    const insertedItemIds = [];
    const seenEmployeeDate = new Set();

    for (const itemData of items) {
      const employeeId = normalize(itemData.employeeId);
      const plannedDate = normalizeDate(itemData.plannedDate ?? itemData.date, 'plannedDate');
      const plannedHours = normalizePlannedHours(itemData.plannedHours ?? itemData.totalHours);
      const reason = normalize(itemData.reason);

      if (!employeeId || !reason) {
        throw new AppError('Employee ID and reason are required for every plan item.', 400, 'PLAN_ITEM_REQUIRED_FIELDS');
      }

      ensureItemDateWithinPlan(plan, plannedDate);

      const uniqueKey = `${employeeId}|${plannedDate}`;

      if (seenEmployeeDate.has(uniqueKey)) {
        throw new AppError('Duplicate employee/date found in submitted plan items.', 409, 'DUPLICATE_PLAN_ITEM_IN_REQUEST');
      }

      seenEmployeeDate.add(uniqueKey);

      const employee = await getEmployeeById(employeeId, client);

      if (!employee) {
        throw new AppError('Employee not found.', 404, 'EMPLOYEE_NOT_FOUND');
      }

      if (employee.departmentId !== plan.departmentId) {
        throw new AppError('Employee must belong to the overtime plan department.', 400, 'PLAN_EMPLOYEE_DEPARTMENT_MISMATCH');
      }

      let result;

      try {
        result = await client.query(
          `
            INSERT INTO overtime_plan_items (
              plan_item_id,
              plan_id,
              employee_id,
              planned_date,
              planned_hours,
              reason
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING plan_item_id;
          `,
          [makeId('PLANITEM'), plan.planId, employeeId, plannedDate, plannedHours, reason]
        );
      } catch (error) {
        if (error.code === '23505') {
          throw new AppError('One or more employees already have planned overtime on the selected date for this plan.', 409, 'DUPLICATE_PLAN_ITEM');
        }

        throw error;
      }

      insertedItemIds.push(result.rows[0].plan_item_id);
    }

    await addPlanLog(plan.planId, 'items_added', createdBy, `${insertedItemIds.length} plan item(s) added.`, client);

    const insertedItemsResult = await client.query(
      `
        ${itemSelect}
        WHERE opi.plan_item_id = ANY($1)
        ORDER BY opi.planned_date ASC, u.last_name ASC, u.first_name ASC;
      `,
      [insertedItemIds]
    );

    return {
      plan: await getOvertimePlan(plan.planId, {}, client),
      items: insertedItemsResult.rows.map(mapPlanItem),
    };
  });
}

async function getOvertimePlanItem(planItemId, executor = { query }) {
  const result = await executor.query(
    `
      ${itemSelect}
      WHERE opi.plan_item_id = $1
      LIMIT 1;
    `,
    [normalize(planItemId)]
  );

  return result.rows[0] ? mapPlanItem(result.rows[0]) : null;
}

async function updateOvertimePlanItem(planId, planItemId, updates, updatedBy) {
  return transaction(async (client) => {
    const plan = await getOvertimePlan(planId, {}, client);

    if (!plan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    ensureDraftPlan(plan);

    const existingItem = await getOvertimePlanItem(planItemId, client);

    if (!existingItem || existingItem.planId !== plan.planId) {
      throw new AppError('Overtime plan item not found.', 404, 'PLAN_ITEM_NOT_FOUND');
    }

    const fields = [];
    const values = [existingItem.planItemId];

    function addField(column, value) {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    }

    let nextEmployeeId = existingItem.employeeId;
    let nextPlannedDate = existingItem.plannedDate;

    if (Object.prototype.hasOwnProperty.call(updates, 'employeeId')) {
      nextEmployeeId = normalize(updates.employeeId);

      if (!nextEmployeeId) {
        throw new AppError('Employee ID cannot be empty.', 400, 'EMPLOYEE_REQUIRED');
      }

      const employee = await getEmployeeById(nextEmployeeId, client);

      if (!employee) {
        throw new AppError('Employee not found.', 404, 'EMPLOYEE_NOT_FOUND');
      }

      if (employee.departmentId !== plan.departmentId) {
        throw new AppError('Employee must belong to the overtime plan department.', 400, 'PLAN_EMPLOYEE_DEPARTMENT_MISMATCH');
      }

      addField('employee_id', nextEmployeeId);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'plannedDate') || Object.prototype.hasOwnProperty.call(updates, 'date')) {
      nextPlannedDate = normalizeDate(updates.plannedDate ?? updates.date, 'plannedDate');
      ensureItemDateWithinPlan(plan, nextPlannedDate);
      addField('planned_date', nextPlannedDate);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'plannedHours') || Object.prototype.hasOwnProperty.call(updates, 'totalHours')) {
      addField('planned_hours', normalizePlannedHours(updates.plannedHours ?? updates.totalHours));
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'reason')) {
      const reason = normalize(updates.reason);

      if (!reason) {
        throw new AppError('Reason cannot be empty.', 400, 'REASON_REQUIRED');
      }

      addField('reason', reason);
    }

    if (fields.length === 0) {
      return {
        plan,
        item: existingItem,
      };
    }

    fields.push('updated_at = NOW()');

    try {
      await client.query(
        `
          UPDATE overtime_plan_items
          SET ${fields.join(', ')}
          WHERE plan_item_id = $1;
        `,
        values
      );
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError('This employee already has planned overtime on this date for this plan.', 409, 'DUPLICATE_PLAN_ITEM');
      }

      throw error;
    }

    await addPlanLog(plan.planId, 'item_updated', updatedBy, `Plan item updated for ${nextPlannedDate}.`, client);

    return {
      plan: await getOvertimePlan(plan.planId, {}, client),
      item: await getOvertimePlanItem(existingItem.planItemId, client),
    };
  });
}

async function deleteOvertimePlanItem(planId, planItemId, deletedBy) {
  return transaction(async (client) => {
    const plan = await getOvertimePlan(planId, {}, client);

    if (!plan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    ensureDraftPlan(plan);

    const existingItem = await getOvertimePlanItem(planItemId, client);

    if (!existingItem || existingItem.planId !== plan.planId) {
      throw new AppError('Overtime plan item not found.', 404, 'PLAN_ITEM_NOT_FOUND');
    }

    await client.query('DELETE FROM overtime_plan_items WHERE plan_item_id = $1;', [existingItem.planItemId]);
    await addPlanLog(plan.planId, 'item_deleted', deletedBy, `Plan item deleted for ${existingItem.plannedDate}.`, client);

    return {
      plan: await getOvertimePlan(plan.planId, {}, client),
      item: existingItem,
    };
  });
}

module.exports = {
  addOvertimePlanItem,
  addOvertimePlanItems,
  buildEmployeePlanWorkflowProgress,
  changeOvertimePlanStatus,
  createEmployeeOvertimePlanDraft,
  createOvertimePlan,
  ensureEmployeePlanCreationPeriodIsAvailable,
  addPlanLog,
  normalizeDate,
  normalizePeriodType,
  validatePlanPeriod,
  makeId,
  deleteOvertimePlan,
  deleteOvertimePlanItem,
  getOvertimePlan,
  getEmployeePlanWorkflowProgress,
  getOvertimePlanItems,
  getOvertimePlanCalendarSummary,
  getOvertimePlans,
  getOvertimePlanItem,
  replaceEmployeeOvertimePlanDraft,
  updateOvertimePlan,
  updateOvertimePlanItem,
};
