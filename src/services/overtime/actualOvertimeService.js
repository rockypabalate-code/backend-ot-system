const { query, transaction } = require('../../config/database');
const AppError = require('../../utils/appError');
const notificationService = require('../notificationService');
const { getEmployeeByUserId } = require('./employeeService');
const {
  dateOnly,
  iso,
  makeId,
  normalize,
  nullable,
  toNumber,
} = require('./shared/utils');

const MAX_ACTUAL_HOURS = 24;
const MAX_COMMENT_LENGTH = 1000;

function mapActualPeriod(row) {
  return {
    actualPeriodId: row.actual_period_id,
    sourceDepartmentPlanId: row.source_department_plan_id,
    departmentId: row.department_id,
    departmentName: row.department_name || '',
    periodType: row.period_type,
    periodStartDate: dateOnly(row.period_start_date),
    periodEndDate: dateOnly(row.period_end_date),
    status: row.status,
    entryCount: toNumber(row.entry_count),
    plannedHours: toNumber(row.planned_hours),
    actualHours: toNumber(row.actual_hours),
    createdBy: row.created_by,
    createdByName: row.created_by_name || '',
    finalizedBy: row.finalized_by || '',
    finalizedByName: row.finalized_by_name || '',
    finalizedAt: iso(row.finalized_at),
    finalizationRemarks: row.finalization_remarks || '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function getActualEntryMetrics(row, today = dateOnly(new Date())) {
  const plannedHours = toNumber(row.planned_hours);
  const storedActualHours = toNumber(row.actual_hours);
  const isUntouchedOpenEntry = row.period_status === 'open' && !row.last_updated_at;
  const isPending = isUntouchedOpenEntry && dateOnly(row.actual_date) >= today;
  const isAutomaticActual = isUntouchedOpenEntry && dateOnly(row.actual_date) < today;
  const actualHours = isPending
    ? 0
    : isAutomaticActual
      ? plannedHours
      : storedActualHours;

  return {
    actualHours,
    isPending,
    varianceHours: isPending ? 0 : actualHours - plannedHours,
  };
}

function mapActualEntry(row) {
  const metrics = getActualEntryMetrics(row);

  return {
    actualEntryId: row.actual_entry_id,
    actualPeriodId: row.actual_period_id,
    sourcePlanItemId: row.source_plan_item_id,
    sourceEmployeePlanId: row.source_employee_plan_id || '',
    employeeId: row.employee_id,
    employeeUserId: row.employee_user_id,
    employeeNo: row.employee_no || '',
    employeeName: row.employee_name || '',
    departmentId: row.department_id,
    supervisorUserId: row.supervisor_user_id || '',
    actualDate: dateOnly(row.actual_date),
    plannedHours: toNumber(row.planned_hours),
    actualHours: metrics.actualHours,
    varianceHours: metrics.varianceHours,
    isPending: metrics.isPending,
    plannedReason: row.planned_reason,
    lastAdjustmentRemarks: row.last_adjustment_remarks || '',
    lastUpdatedBy: row.last_updated_by || '',
    lastUpdatedByName: row.last_updated_by_name || '',
    lastUpdatedAt: iso(row.last_updated_at),
    periodStatus: row.period_status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapComment(row) {
  return {
    commentId: row.comment_id,
    actualEntryId: row.actual_entry_id,
    userId: row.user_id,
    userName: row.user_name || '',
    userRole: row.user_role || '',
    remarks: row.remarks,
    createdAt: iso(row.created_at),
  };
}

function mapAdjustment(row) {
  return {
    adjustmentId: row.adjustment_id,
    actualEntryId: row.actual_entry_id,
    previousHours: toNumber(row.previous_hours),
    newHours: toNumber(row.new_hours),
    changedBy: row.changed_by,
    changedByName: row.changed_by_name || '',
    remarks: row.remarks,
    changedAt: iso(row.changed_at),
  };
}

async function addActualActivity({
  actualPeriodId,
  actualEntryId = null,
  action,
  actionBy,
  remarks,
}, executor = { query }) {
  const activityId = makeId('ACTUALACTIVITY');
  const result = await executor.query(
    `
      INSERT INTO overtime_actual_activity_logs (
        activity_id,
        actual_period_id,
        actual_entry_id,
        action,
        action_by,
        remarks
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING activity_id;
    `,
    [
      activityId,
      normalize(actualPeriodId),
      actualEntryId ? normalize(actualEntryId) : null,
      normalize(action),
      normalize(actionBy),
      nullable(remarks),
    ]
  );

  await notificationService.createActualOvertimeNotifications({
    actualPeriodId,
    actualEntryId,
    activityId: result.rows[0].activity_id,
    action,
    actionBy,
    remarks,
  }, executor);

  return result.rows[0];
}

const periodSelect = `
  SELECT
    actual_period.*,
    department.department_name,
    CONCAT_WS(' ', creator.first_name, NULLIF(creator.middle_name, ''), creator.last_name) AS created_by_name,
    CONCAT_WS(' ', finalizer.first_name, NULLIF(finalizer.middle_name, ''), finalizer.last_name) AS finalized_by_name,
    COUNT(actual_entry.actual_entry_id)::INTEGER AS entry_count,
    COALESCE(SUM(actual_entry.planned_hours), 0)::NUMERIC AS planned_hours,
    COALESCE(SUM(
      CASE
        WHEN actual_period.status = 'open'
          AND actual_entry.last_updated_at IS NULL
          AND actual_entry.actual_date >= CURRENT_DATE
          THEN 0
        ELSE actual_entry.actual_hours
      END
    ), 0)::NUMERIC AS actual_hours
  FROM overtime_actual_periods actual_period
  INNER JOIN departments department ON department.department_id = actual_period.department_id
  INNER JOIN users creator ON creator.id = actual_period.created_by
  LEFT JOIN users finalizer ON finalizer.id = actual_period.finalized_by
  LEFT JOIN overtime_actual_entries actual_entry ON actual_entry.actual_period_id = actual_period.actual_period_id
`;

const entrySelect = `
  SELECT
    actual_entry.*,
    actual_period.department_id,
    actual_period.status AS period_status,
    employee.user_id AS employee_user_id,
    employee.employee_no,
    employee.supervisor_user_id,
    CONCAT_WS(' ', employee_user.first_name, NULLIF(employee_user.middle_name, ''), employee_user.last_name) AS employee_name,
    CONCAT_WS(' ', updater.first_name, NULLIF(updater.middle_name, ''), updater.last_name) AS last_updated_by_name
  FROM overtime_actual_entries actual_entry
  INNER JOIN overtime_actual_periods actual_period ON actual_period.actual_period_id = actual_entry.actual_period_id
  INNER JOIN employees employee ON employee.employee_id = actual_entry.employee_id
  INNER JOIN users employee_user ON employee_user.id = employee.user_id
  LEFT JOIN users updater ON updater.id = actual_entry.last_updated_by
`;

async function getActualPeriodRecord(actualPeriodId, executor = { query }) {
  const result = await executor.query(
    `
      ${periodSelect}
      WHERE actual_period.actual_period_id = $1
      GROUP BY actual_period.actual_period_id, department.department_name,
        creator.first_name, creator.middle_name, creator.last_name,
        finalizer.first_name, finalizer.middle_name, finalizer.last_name
      LIMIT 1;
    `,
    [normalize(actualPeriodId)]
  );

  return result.rows[0] ? mapActualPeriod(result.rows[0]) : null;
}

async function getActualEntryRecord(actualEntryId, executor = { query }) {
  const result = await executor.query(
    `${entrySelect} WHERE actual_entry.actual_entry_id = $1 LIMIT 1;`,
    [normalize(actualEntryId)]
  );

  return result.rows[0] ? mapActualEntry(result.rows[0]) : null;
}

async function requireEmployeeProfile(user, executor) {
  const employee = await getEmployeeByUserId(user.id, executor);

  if (!employee) {
    throw new AppError(
      'Your account is not linked to an employee profile.',
      403,
      user.role === 'supervisor'
        ? 'SUPERVISOR_EMPLOYEE_PROFILE_REQUIRED'
        : 'EMPLOYEE_PROFILE_REQUIRED'
    );
  }

  return employee;
}

async function ensurePeriodReadAccess(period, user, executor) {
  if (['admin', 'hr', 'japanese_management'].includes(user.role)) {
    return null;
  }

  const employee = await requireEmployeeProfile(user, executor);

  if (user.role === 'supervisor' && employee.departmentId === period.departmentId) {
    return employee;
  }

  if (user.role === 'user') {
    const result = await executor.query(
      `
        SELECT 1
        FROM overtime_actual_entries actual_entry
        WHERE actual_entry.actual_period_id = $1
          AND actual_entry.employee_id = $2
        LIMIT 1;
      `,
      [period.actualPeriodId, employee.employeeId]
    );

    if (result.rows.length > 0) {
      return employee;
    }
  }

  throw new AppError(
    'You do not have permission to access this Actual OT period.',
    403,
    'ACTUAL_OVERTIME_ACCESS_FORBIDDEN'
  );
}

async function ensureEntryAccess(entry, user, executor, options = {}) {
  const { write = false } = options;

  if (['admin', 'hr'].includes(user.role)) {
    return null;
  }

  if (user.role === 'japanese_management') {
    if (!write) {
      return null;
    }

    throw new AppError(
      'Japanese Management has view-only access to Actual OT records.',
      403,
      'ACTUAL_OVERTIME_EDIT_FORBIDDEN'
    );
  }

  const employee = await requireEmployeeProfile(user, executor);

  if (
    user.role === 'supervisor'
    && employee.departmentId === entry.departmentId
    && entry.supervisorUserId === user.id
  ) {
    return employee;
  }

  if (!write && user.role === 'user' && entry.employeeId === employee.employeeId) {
    return employee;
  }

  throw new AppError(
    write
      ? 'You do not have permission to edit this Actual OT entry.'
      : 'You do not have permission to access this Actual OT entry.',
    403,
    write ? 'ACTUAL_OVERTIME_EDIT_FORBIDDEN' : 'ACTUAL_OVERTIME_ACCESS_FORBIDDEN'
  );
}

async function createActualPeriodFromApprovedPlan(planId, createdBy, executor = { query }) {
  const planResult = await executor.query(
    `
      SELECT *
      FROM overtime_plans
      WHERE plan_id = $1
      LIMIT 1;
    `,
    [normalize(planId)]
  );
  const plan = planResult.rows[0];

  if (!plan) {
    throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
  }

  if (plan.plan_scope !== 'department' || plan.status !== 'approved') {
    throw new AppError(
      'Actual OT can be created only from a fully approved Department OT Plan.',
      400,
      'DEPARTMENT_PLAN_NOT_APPROVED'
    );
  }

  const actualPeriodId = makeId('ACTUALPERIOD');
  await executor.query(
    `
      INSERT INTO overtime_actual_periods (
        actual_period_id,
        source_department_plan_id,
        department_id,
        period_type,
        period_start_date,
        period_end_date,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (source_department_plan_id) DO NOTHING;
    `,
    [
      actualPeriodId,
      plan.plan_id,
      plan.department_id,
      plan.period_type,
      plan.period_start_date,
      plan.period_end_date,
      createdBy,
    ]
  );

  const periodResult = await executor.query(
    `
      SELECT actual_period_id
      FROM overtime_actual_periods
      WHERE source_department_plan_id = $1
      LIMIT 1;
    `,
    [plan.plan_id]
  );
  const persistedPeriodId = periodResult.rows[0].actual_period_id;
  const itemResult = await executor.query(
    `
      SELECT plan_item_id, source_employee_plan_id, employee_id, planned_date, planned_hours, reason
      FROM overtime_plan_items
      WHERE plan_id = $1
      ORDER BY planned_date, employee_id;
    `,
    [plan.plan_id]
  );

  if (itemResult.rows.length === 0) {
    throw new AppError(
      'The approved Department OT Plan has no items to convert into Actual OT.',
      400,
      'ACTUAL_OVERTIME_ITEMS_REQUIRED'
    );
  }

  for (const item of itemResult.rows) {
    await executor.query(
      `
        INSERT INTO overtime_actual_entries (
          actual_entry_id,
          actual_period_id,
          source_plan_item_id,
          source_employee_plan_id,
          employee_id,
          actual_date,
          planned_hours,
          actual_hours,
          planned_reason
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7::NUMERIC,
          CASE WHEN $6::DATE >= CURRENT_DATE THEN 0::NUMERIC ELSE $7::NUMERIC END,
          $8
        )
        ON CONFLICT (source_plan_item_id) DO NOTHING;
      `,
      [
        makeId('ACTUALENTRY'),
        persistedPeriodId,
        item.plan_item_id,
        item.source_employee_plan_id,
        item.employee_id,
        item.planned_date,
        item.planned_hours,
        item.reason,
      ]
    );
  }

  return getActualPeriodRecord(persistedPeriodId, executor);
}

async function listActualPeriods(filters, user, executor = { query }) {
  const clauses = [];
  const values = [];
  const addFilter = (sql, value) => {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  };

  if (filters.status) {
    const status = normalize(filters.status);
    if (!['open', 'finalized'].includes(status)) {
      throw new AppError('Actual OT status must be open or finalized.', 400, 'INVALID_ACTUAL_OVERTIME_STATUS');
    }
    addFilter('actual_period.status = ?', status);
  }
  if (filters.departmentId) addFilter('actual_period.department_id = ?', normalize(filters.departmentId));
  if (filters.dateFrom) addFilter('actual_period.period_end_date >= ?', normalize(filters.dateFrom));
  if (filters.dateTo) addFilter('actual_period.period_start_date <= ?', normalize(filters.dateTo));

  if (user.role === 'user') {
    const employee = await requireEmployeeProfile(user, executor);
    addFilter('actual_entry.employee_id = ?', employee.employeeId);
  } else if (user.role === 'supervisor') {
    const employee = await requireEmployeeProfile(user, executor);
    addFilter('actual_period.department_id = ?', employee.departmentId);
    addFilter(
      `actual_entry.employee_id IN (
        SELECT scoped_employee.employee_id
        FROM employees scoped_employee
        WHERE scoped_employee.supervisor_user_id = ?
      )`,
      user.id
    );
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await executor.query(
    `
      ${periodSelect}
      ${where}
      GROUP BY actual_period.actual_period_id, department.department_name,
        creator.first_name, creator.middle_name, creator.last_name,
        finalizer.first_name, finalizer.middle_name, finalizer.last_name
      ORDER BY actual_period.period_start_date DESC, actual_period.created_at DESC;
    `,
    values
  );

  return result.rows.map(mapActualPeriod);
}

async function getActualPeriod(actualPeriodId, user, executor = { query }) {
  const period = await getActualPeriodRecord(actualPeriodId, executor);

  if (!period) {
    throw new AppError('Actual OT period not found.', 404, 'ACTUAL_OVERTIME_PERIOD_NOT_FOUND');
  }

  const employee = await ensurePeriodReadAccess(period, user, executor);
  const values = [period.actualPeriodId];
  let scope = '';

  if (user.role === 'user') {
    values.push(employee.employeeId);
    scope = `AND actual_entry.employee_id = $${values.length}`;
  } else if (user.role === 'supervisor') {
    values.push(user.id);
    scope = `AND employee.supervisor_user_id = $${values.length}`;
  }

  const entryResult = await executor.query(
    `${entrySelect}
      WHERE actual_entry.actual_period_id = $1
      ${scope}
      ORDER BY actual_entry.actual_date, employee.employee_no, actual_entry.actual_entry_id;
    `,
    values
  );
  const entries = entryResult.rows.map(mapActualEntry);
  const entryIds = entries.map((entry) => entry.actualEntryId);
  const scopedPeriod = ['user', 'supervisor'].includes(user.role)
    ? {
      ...period,
      entryCount: entries.length,
      plannedHours: entries.reduce((sum, entry) => sum + entry.plannedHours, 0),
      actualHours: entries.reduce((sum, entry) => sum + entry.actualHours, 0),
    }
    : period;

  if (entryIds.length === 0) {
    return { ...scopedPeriod, entries: [] };
  }

  const commentResult = await executor.query(
    `
      SELECT comment.*,
        user_account.role AS user_role,
        CONCAT_WS(' ', user_account.first_name, NULLIF(user_account.middle_name, ''), user_account.last_name) AS user_name
      FROM overtime_actual_comments comment
      INNER JOIN users user_account ON user_account.id = comment.user_id
      WHERE comment.actual_entry_id = ANY($1::TEXT[])
      ORDER BY comment.created_at;
    `,
    [entryIds]
  );
  const commentsByEntry = new Map();
  for (const comment of commentResult.rows.map(mapComment)) {
    const comments = commentsByEntry.get(comment.actualEntryId) || [];
    comments.push(comment);
    commentsByEntry.set(comment.actualEntryId, comments);
  }

  let adjustmentsByEntry = new Map();
  if (['admin', 'hr', 'supervisor', 'japanese_management'].includes(user.role)) {
    const adjustmentResult = await executor.query(
      `
        SELECT adjustment.*,
          CONCAT_WS(' ', changer.first_name, NULLIF(changer.middle_name, ''), changer.last_name) AS changed_by_name
        FROM overtime_actual_adjustment_logs adjustment
        INNER JOIN users changer ON changer.id = adjustment.changed_by
        WHERE adjustment.actual_entry_id = ANY($1::TEXT[])
        ORDER BY adjustment.changed_at;
      `,
      [entryIds]
    );
    adjustmentsByEntry = new Map();
    for (const adjustment of adjustmentResult.rows.map(mapAdjustment)) {
      const adjustments = adjustmentsByEntry.get(adjustment.actualEntryId) || [];
      adjustments.push(adjustment);
      adjustmentsByEntry.set(adjustment.actualEntryId, adjustments);
    }
  }

  return {
    ...scopedPeriod,
    entries: entries.map((entry) => ({
      ...entry,
      comments: commentsByEntry.get(entry.actualEntryId) || [],
      ...(['admin', 'hr', 'supervisor', 'japanese_management'].includes(user.role)
        ? { adjustments: adjustmentsByEntry.get(entry.actualEntryId) || [] }
        : {}),
    })),
  };
}

function parseActualHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0 || hours > MAX_ACTUAL_HOURS) {
    throw new AppError(
      `Actual hours must be a number from 0 to ${MAX_ACTUAL_HOURS}.`,
      400,
      'INVALID_ACTUAL_HOURS'
    );
  }
  return Math.round(hours * 100) / 100;
}

async function updateActualEntry(actualEntryId, body, user) {
  if (!['admin', 'hr', 'supervisor'].includes(user.role)) {
    throw new AppError(
      'Only Admin, HR, or the assigned supervisor can edit Actual OT.',
      403,
      'ACTUAL_OVERTIME_EDIT_FORBIDDEN'
    );
  }

  const remarks = nullable(body.remarks);
  if (!remarks) {
    throw new AppError(
      'Remarks are required when adjusting Actual OT.',
      400,
      'ACTUAL_OVERTIME_ADJUSTMENT_REMARKS_REQUIRED'
    );
  }

  if (!Object.prototype.hasOwnProperty.call(body, 'actualHours')) {
    throw new AppError(
      'actualHours is required when adjusting Actual OT.',
      400,
      'ACTUAL_OVERTIME_ADJUSTMENT_REQUIRED'
    );
  }

  return transaction(async (client) => {
    await client.query(
      'SELECT actual_entry_id FROM overtime_actual_entries WHERE actual_entry_id = $1 FOR UPDATE;',
      [normalize(actualEntryId)]
    );
    const entry = await getActualEntryRecord(actualEntryId, client);

    if (!entry) {
      throw new AppError('Actual OT entry not found.', 404, 'ACTUAL_OVERTIME_ENTRY_NOT_FOUND');
    }
    if (entry.periodStatus !== 'open') {
      throw new AppError('Finalized Actual OT cannot be edited.', 400, 'ACTUAL_OVERTIME_FINALIZED');
    }

    await ensureEntryAccess(entry, user, client, { write: true });
    const actualHours = parseActualHours(body.actualHours);

    await client.query(
      `
        INSERT INTO overtime_actual_adjustment_logs (
          adjustment_id,
          actual_entry_id,
          previous_hours,
          new_hours,
          changed_by,
          remarks
        )
        VALUES ($1, $2, $3, $4, $5, $6);
      `,
      [
        makeId('ACTUALADJUSTMENT'),
        entry.actualEntryId,
        entry.actualHours,
        actualHours,
        user.id,
        remarks,
      ]
    );
    await client.query(
      `
        UPDATE overtime_actual_entries
        SET actual_hours = $2,
            last_adjustment_remarks = $3,
            last_updated_by = $4,
            last_updated_at = NOW(),
            updated_at = NOW()
        WHERE actual_entry_id = $1;
      `,
      [entry.actualEntryId, actualHours, remarks, user.id]
    );

    await addActualActivity({
      actualPeriodId: entry.actualPeriodId,
      actualEntryId: entry.actualEntryId,
      action: 'actual_hours_updated',
      actionBy: user.id,
      remarks,
    }, client);

    return getActualEntryRecord(entry.actualEntryId, client);
  });
}

async function addActualEntryComment(actualEntryId, remarksValue, user) {
  const remarks = nullable(remarksValue);
  if (!remarks) {
    throw new AppError('Comment remarks are required.', 400, 'ACTUAL_OVERTIME_COMMENT_REQUIRED');
  }
  if (remarks.length > MAX_COMMENT_LENGTH) {
    throw new AppError(
      `Comment remarks must not exceed ${MAX_COMMENT_LENGTH} characters.`,
      400,
      'ACTUAL_OVERTIME_COMMENT_TOO_LONG'
    );
  }

  return transaction(async (client) => {
    const entry = await getActualEntryRecord(actualEntryId, client);
    if (!entry) {
      throw new AppError('Actual OT entry not found.', 404, 'ACTUAL_OVERTIME_ENTRY_NOT_FOUND');
    }
    if (entry.periodStatus !== 'open') {
      throw new AppError('Comments cannot be added after Actual OT is finalized.', 400, 'ACTUAL_OVERTIME_FINALIZED');
    }

    await ensureEntryAccess(entry, user, client, { write: false });
    const result = await client.query(
      `
        INSERT INTO overtime_actual_comments (comment_id, actual_entry_id, user_id, remarks)
        VALUES ($1, $2, $3, $4)
        RETURNING *;
      `,
      [makeId('ACTUALCOMMENT'), entry.actualEntryId, user.id, remarks]
    );
    const row = result.rows[0];
    await addActualActivity({
      actualPeriodId: entry.actualPeriodId,
      actualEntryId: entry.actualEntryId,
      action: 'actual_comment_added',
      actionBy: user.id,
      remarks,
    }, client);
    row.user_name = [user.firstName, user.middleName, user.lastName].map(normalize).filter(Boolean).join(' ')
      || user.name
      || '';
    row.user_role = user.role;
    return mapComment(row);
  });
}

async function finalizeActualPeriod(actualPeriodId, remarks, user) {
  if (!['admin', 'hr'].includes(user.role)) {
    throw new AppError(
      'Only Admin or HR can finalize an Actual OT period.',
      403,
      'ACTUAL_OVERTIME_FINALIZE_FORBIDDEN'
    );
  }

  return transaction(async (client) => {
    const lockResult = await client.query(
      'SELECT status FROM overtime_actual_periods WHERE actual_period_id = $1 FOR UPDATE;',
      [normalize(actualPeriodId)]
    );
    if (lockResult.rows.length === 0) {
      throw new AppError('Actual OT period not found.', 404, 'ACTUAL_OVERTIME_PERIOD_NOT_FOUND');
    }
    if (lockResult.rows[0].status === 'finalized') {
      throw new AppError('Actual OT period is already finalized.', 409, 'ACTUAL_OVERTIME_ALREADY_FINALIZED');
    }

    const countResult = await client.query(
      'SELECT COUNT(*)::INTEGER AS entry_count FROM overtime_actual_entries WHERE actual_period_id = $1;',
      [normalize(actualPeriodId)]
    );
    if (Number(countResult.rows[0].entry_count) === 0) {
      throw new AppError('Actual OT period has no entries to finalize.', 400, 'ACTUAL_OVERTIME_ENTRIES_REQUIRED');
    }

    await client.query(
      `
        UPDATE overtime_actual_periods
        SET status = 'finalized',
            finalized_by = $2,
            finalized_at = NOW(),
            finalization_remarks = $3,
            updated_at = NOW()
        WHERE actual_period_id = $1;
      `,
      [normalize(actualPeriodId), user.id, nullable(remarks)]
    );
    await addActualActivity({
      actualPeriodId,
      action: 'actual_period_finalized',
      actionBy: user.id,
      remarks,
    }, client);
    return getActualPeriodRecord(actualPeriodId, client);
  });
}

module.exports = {
  addActualActivity,
  addActualEntryComment,
  createActualPeriodFromApprovedPlan,
  finalizeActualPeriod,
  getActualEntryMetrics,
  getActualEntryRecord,
  getActualPeriod,
  getActualPeriodRecord,
  listActualPeriods,
  updateActualEntry,
};
