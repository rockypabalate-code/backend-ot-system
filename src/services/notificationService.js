const { query } = require('../config/database');
const AppError = require('../utils/appError');

const ACTION_TITLES = {
  created: 'Overtime plan created',
  updated: 'Overtime plan updated',
  item_added: 'Overtime entry added',
  items_added: 'Overtime entries added',
  draft_saved: 'Overtime draft saved',
  item_updated: 'Overtime entry updated',
  item_deleted: 'Overtime entry removed',
  submitted: 'Overtime plan submitted',
  submitted_to_supervisor: 'Plan submitted for review',
  submission_withdrawn: 'Employee withdrew the plan',
  supervisor_accepted: 'Supervisor accepted the plan',
  supervisor_returned: 'Supervisor returned the plan',
  pending_approval: 'Plan is pending approval',
  approved: 'Overtime plan approved',
  rejected: 'Overtime plan rejected',
  returned_for_revision: 'Plan returned for revision',
  closed: 'Overtime plan closed',
  signed: 'Overtime plan signed',
  employee_plan_signed_self: 'Overtime plan signed',
  employee_plan_signed_by_supervisor_on_behalf: 'Plan signed by supervisor',
  department_plan_created_from_employee_drafts: 'Department plan created',
  department_plan_submitted_for_assigned_approval: 'Department plan submitted for approval',
  department_plan_submitted_and_signed_by_supervisor: 'Department plan signed by supervisor',
  assigned_preliminary_approval_approved: 'Approval step completed',
  department_plan_final_approved: 'Department plan approved',
  department_plan_returned_for_revision: 'Department plan returned for revision',
  actual_overtime_period_created: 'Actual overtime period created',
  admin_hr_status_reset: 'Overtime plan status reset',
  supervisor_status_reset: 'Supervisor reset the plan status',
};

const ACTUAL_ACTION_TITLES = {
  actual_hours_updated: 'Actual overtime hours updated',
  actual_comment_added: 'New actual overtime comment',
  actual_period_finalized: 'Actual overtime period finalized',
};

function normalize(value) {
  return String(value ?? '').trim();
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') {
    return 20;
  }

  const limit = Number(value);

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new AppError('Limit must be a positive whole number.', 400, 'INVALID_NOTIFICATION_LIMIT');
  }

  return Math.min(limit, 100);
}

function normalizeOffset(value) {
  if (value === undefined || value === null || value === '') {
    return 0;
  }

  const offset = Number(value);

  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError('Offset must be zero or a positive whole number.', 400, 'INVALID_NOTIFICATION_OFFSET');
  }

  return offset;
}

function titleForAction(action) {
  if (ACTION_TITLES[action]) {
    return ACTION_TITLES[action];
  }

  const readableAction = normalize(action).replaceAll('_', ' ');
  return readableAction ? `Overtime plan ${readableAction}` : 'Overtime plan activity';
}

function titleForActualAction(action) {
  return ACTUAL_ACTION_TITLES[action] || 'Actual overtime activity';
}

function dateOnly(value) {
  if (!value) return null;
  if (!(value instanceof Date)) return value;

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mapNotification(row) {
  const targetType = row.actual_period_id ? 'actual_overtime' : 'plan';

  return {
    notificationId: row.notification_id,
    recipientUserId: row.recipient_user_id,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name || null,
    targetType,
    planId: row.plan_id || null,
    logId: row.log_id || null,
    actualPeriodId: row.actual_period_id || null,
    actualEntryId: row.actual_entry_id || null,
    actualActivityId: row.actual_activity_id || null,
    actualDate: dateOnly(row.actual_date),
    type: row.notification_type,
    title: row.title,
    message: row.message,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    planStatus: row.plan_status || null,
    actualPeriodStatus: row.actual_period_status || null,
    periodStartDate: dateOnly(row.target_period_start_date || row.period_start_date),
    periodEndDate: dateOnly(row.target_period_end_date || row.period_end_date),
  };
}

async function createPlanLogNotifications({ planId, logId, action, actionBy, remarks }, executor = { query }) {
  const normalizedPlanId = normalize(planId);
  const normalizedLogId = normalize(logId);
  const normalizedActionBy = normalize(actionBy);
  const title = titleForAction(action);
  const message = normalize(remarks) || title;

  const result = await executor.query(
    `
      WITH recipients AS (
        SELECT op.created_by AS recipient_user_id
        FROM overtime_plans op
        WHERE op.plan_id = $1

        UNION

        SELECT employee_user.user_id
        FROM overtime_plan_items item
        JOIN employees employee_user ON employee_user.employee_id = item.employee_id
        JOIN overtime_plans employee_plan ON employee_plan.plan_id = item.plan_id
        WHERE item.plan_id = $1
          AND employee_plan.status = 'approved'

        UNION

        SELECT employee_supervisor.supervisor_user_id
        FROM overtime_plan_items item
        JOIN employees employee_supervisor ON employee_supervisor.employee_id = item.employee_id
        WHERE item.plan_id = $1

        UNION

        SELECT op.current_approver_user_id
        FROM overtime_plans op
        WHERE op.plan_id = $1
      ), eligible_recipients AS (
        SELECT DISTINCT recipients.recipient_user_id
        FROM recipients
        JOIN users recipient ON recipient.id = recipients.recipient_user_id
        WHERE recipients.recipient_user_id IS NOT NULL
          AND recipients.recipient_user_id <> $2
          AND recipient.status = 'active'
      )
      INSERT INTO notifications (
        notification_id,
        recipient_user_id,
        actor_user_id,
        plan_id,
        log_id,
        notification_type,
        title,
        message
      )
      SELECT
        CONCAT('NOTIFICATION-', $3::TEXT, '-', eligible_recipients.recipient_user_id),
        eligible_recipients.recipient_user_id,
        $2,
        $1,
        $3,
        $4,
        $5,
        $6
      FROM eligible_recipients
      ON CONFLICT (recipient_user_id, log_id) DO NOTHING
      RETURNING notification_id;
    `,
    [normalizedPlanId, normalizedActionBy, normalizedLogId, normalize(action), title, message]
  );

  return result.rows;
}

async function createActualOvertimeNotifications({
  actualPeriodId,
  actualEntryId,
  activityId,
  action,
  actionBy,
  remarks,
}, executor = { query }) {
  const title = titleForActualAction(action);
  const message = normalize(remarks) || title;
  const result = await executor.query(
    `
      WITH recipients AS (
        SELECT employee.user_id AS recipient_user_id
        FROM overtime_actual_entries actual_entry
        INNER JOIN employees employee ON employee.employee_id = actual_entry.employee_id
        WHERE (
          $5 = 'actual_period_finalized'
          AND actual_entry.actual_period_id = $1
        ) OR (
          $5 IN ('actual_hours_updated', 'actual_comment_added')
          AND actual_entry.actual_entry_id = $2
        )

        UNION

        SELECT employee.supervisor_user_id
        FROM overtime_actual_entries actual_entry
        INNER JOIN employees employee ON employee.employee_id = actual_entry.employee_id
        WHERE $5 = 'actual_comment_added'
          AND actual_entry.actual_entry_id = $2
      ), eligible_recipients AS (
        SELECT DISTINCT recipients.recipient_user_id
        FROM recipients
        INNER JOIN users recipient ON recipient.id = recipients.recipient_user_id
        WHERE recipients.recipient_user_id IS NOT NULL
          AND recipients.recipient_user_id <> $3
          AND recipient.status = 'active'
      )
      INSERT INTO notifications (
        notification_id,
        recipient_user_id,
        actor_user_id,
        actual_period_id,
        actual_entry_id,
        actual_activity_id,
        notification_type,
        title,
        message
      )
      SELECT
        CONCAT('NOTIFICATION-', $4::TEXT, '-', eligible_recipients.recipient_user_id),
        eligible_recipients.recipient_user_id,
        $3,
        $1,
        $2,
        $4,
        $5,
        $6,
        $7
      FROM eligible_recipients
      ON CONFLICT DO NOTHING
      RETURNING notification_id;
    `,
    [
      normalize(actualPeriodId),
      normalize(actualEntryId) || null,
      normalize(actionBy),
      normalize(activityId),
      normalize(action),
      title,
      message,
    ]
  );

  return result.rows;
}

async function listNotifications(userId, options = {}, executor = { query }) {
  const recipientUserId = normalize(userId);
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const unreadOnly = options.unreadOnly === true;
  const unreadClause = unreadOnly ? 'AND notification.read_at IS NULL' : '';

  const [notificationResult, countResult] = await Promise.all([
    executor.query(
      `
        SELECT
          notification.*,
          CONCAT_WS(' ', actor.first_name, NULLIF(actor.middle_name, ''), actor.last_name) AS actor_name,
          plan.status AS plan_status,
          actual_period.status AS actual_period_status,
          COALESCE(plan.period_start_date, actual_period.period_start_date) AS target_period_start_date,
          COALESCE(plan.period_end_date, actual_period.period_end_date) AS target_period_end_date,
          actual_entry.actual_date
        FROM notifications notification
        LEFT JOIN overtime_plans plan ON plan.plan_id = notification.plan_id
        LEFT JOIN overtime_actual_periods actual_period
          ON actual_period.actual_period_id = notification.actual_period_id
        LEFT JOIN overtime_actual_entries actual_entry
          ON actual_entry.actual_entry_id = notification.actual_entry_id
        LEFT JOIN users actor ON actor.id = notification.actor_user_id
        WHERE notification.recipient_user_id = $1
          ${unreadClause}
        ORDER BY notification.created_at DESC, notification.notification_id DESC
        LIMIT $2 OFFSET $3;
      `,
      [recipientUserId, limit, offset]
    ),
    executor.query(
      `
        SELECT
          COUNT(*)::INTEGER AS total_count,
          COUNT(*) FILTER (WHERE read_at IS NULL)::INTEGER AS unread_count
        FROM notifications
        WHERE recipient_user_id = $1;
      `,
      [recipientUserId]
    ),
  ]);

  const counts = countResult.rows[0] || {};

  return {
    notifications: notificationResult.rows.map(mapNotification),
    pagination: {
      limit,
      offset,
      total: Number(counts.total_count || 0),
    },
    unreadCount: Number(counts.unread_count || 0),
  };
}

async function getUnreadNotificationCount(userId, executor = { query }) {
  const result = await executor.query(
    `
      SELECT COUNT(*)::INTEGER AS unread_count
      FROM notifications
      WHERE recipient_user_id = $1
        AND read_at IS NULL;
    `,
    [normalize(userId)]
  );

  return Number(result.rows[0]?.unread_count || 0);
}

async function markNotificationRead(notificationId, userId, executor = { query }) {
  const result = await executor.query(
    `
      WITH updated_notification AS (
        UPDATE notifications
        SET read_at = COALESCE(read_at, NOW())
        WHERE notification_id = $1
          AND recipient_user_id = $2
        RETURNING *
      )
      SELECT
        updated_notification.*,
        CONCAT_WS(' ', actor.first_name, NULLIF(actor.middle_name, ''), actor.last_name) AS actor_name,
        plan.status AS plan_status,
        actual_period.status AS actual_period_status,
        COALESCE(plan.period_start_date, actual_period.period_start_date) AS target_period_start_date,
        COALESCE(plan.period_end_date, actual_period.period_end_date) AS target_period_end_date,
        actual_entry.actual_date
      FROM updated_notification
      LEFT JOIN overtime_plans plan ON plan.plan_id = updated_notification.plan_id
      LEFT JOIN overtime_actual_periods actual_period
        ON actual_period.actual_period_id = updated_notification.actual_period_id
      LEFT JOIN overtime_actual_entries actual_entry
        ON actual_entry.actual_entry_id = updated_notification.actual_entry_id
      LEFT JOIN users actor ON actor.id = updated_notification.actor_user_id;
    `,
    [normalize(notificationId), normalize(userId)]
  );

  if (!result.rows[0]) {
    throw new AppError('Notification not found.', 404, 'NOTIFICATION_NOT_FOUND');
  }

  return mapNotification(result.rows[0]);
}

async function markAllNotificationsRead(userId, executor = { query }) {
  const result = await executor.query(
    `
      UPDATE notifications
      SET read_at = NOW()
      WHERE recipient_user_id = $1
        AND read_at IS NULL;
    `,
    [normalize(userId)]
  );

  return result.rowCount;
}

async function markPlanNotificationsRead(planId, userId, executor = { query }) {
  const result = await executor.query(
    `
      UPDATE notifications
      SET read_at = NOW()
      WHERE plan_id = $1
        AND recipient_user_id = $2
        AND read_at IS NULL;
    `,
    [normalize(planId), normalize(userId)]
  );

  return result.rowCount;
}

async function markActualPeriodNotificationsRead(actualPeriodId, userId, executor = { query }) {
  const result = await executor.query(
    `
      UPDATE notifications
      SET read_at = NOW()
      WHERE actual_period_id = $1
        AND recipient_user_id = $2
        AND read_at IS NULL;
    `,
    [normalize(actualPeriodId), normalize(userId)]
  );

  return result.rowCount;
}

module.exports = {
  createActualOvertimeNotifications,
  createPlanLogNotifications,
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markActualPeriodNotificationsRead,
  markNotificationRead,
  markPlanNotificationsRead,
  titleForActualAction,
  titleForAction,
};
