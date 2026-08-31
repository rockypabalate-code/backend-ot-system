const { query, transaction } = require('../../config/database');
const AppError = require('../../utils/appError');
const { iso, makeId, normalize, nullable } = require('./shared/utils');

const MAX_PURGE_REMARKS_LENGTH = 1000;

function mapPurgeAudit(row) {
  return {
    purgeAuditId: row.purge_audit_id,
    departmentPlanId: row.department_plan_id,
    performedBy: row.performed_by,
    remarks: row.remarks,
    deleteSourceEmployeePlans: row.delete_source_employee_plans,
    deletedRecordCounts: row.deleted_record_counts || {},
    excelFilesDeleted: row.excel_files_deleted,
    status: row.status,
    errorMessage: row.error_message || '',
    performedAt: iso(row.performed_at),
    completedAt: iso(row.completed_at),
  };
}

function validatePurgeRequest(planId, purgeData, actionByUser) {
  if (!actionByUser || actionByUser.role !== 'admin') {
    throw new AppError(
      'Only Admin can permanently purge OT data.',
      403,
      'OVERTIME_PURGE_ADMIN_ONLY'
    );
  }

  const normalizedPlanId = normalize(planId);
  const confirmedPlanId = normalize(purgeData.confirmPlanId);
  const remarks = nullable(purgeData.remarks);

  if (!normalizedPlanId) {
    throw new AppError('Department Plan ID is required.', 400, 'PURGE_PLAN_ID_REQUIRED');
  }
  if (!confirmedPlanId || confirmedPlanId !== normalizedPlanId) {
    throw new AppError(
      'confirmPlanId must exactly match the Department Plan ID in the endpoint.',
      400,
      'PURGE_PLAN_CONFIRMATION_MISMATCH'
    );
  }
  if (!remarks) {
    throw new AppError('Purge remarks are required.', 400, 'PURGE_REMARKS_REQUIRED');
  }
  if (remarks.length > MAX_PURGE_REMARKS_LENGTH) {
    throw new AppError(
      `Purge remarks must not exceed ${MAX_PURGE_REMARKS_LENGTH} characters.`,
      400,
      'PURGE_REMARKS_TOO_LONG'
    );
  }
  if (typeof purgeData.deleteSourceEmployeePlans !== 'boolean') {
    throw new AppError(
      'deleteSourceEmployeePlans must explicitly be true or false.',
      400,
      'PURGE_SOURCE_PLAN_CONFIRMATION_REQUIRED'
    );
  }
  if (purgeData.confirmKeepExcel !== true) {
    throw new AppError(
      'confirmKeepExcel must be true to confirm that generated Excel files will remain in Supabase Storage.',
      400,
      'PURGE_EXCEL_RETENTION_CONFIRMATION_REQUIRED'
    );
  }

  return {
    planId: normalizedPlanId,
    remarks,
    deleteSourceEmployeePlans: purgeData.deleteSourceEmployeePlans,
  };
}

async function getDepartmentPlanForPurge(planId, executor = { query }, options = {}) {
  const lockClause = options.lock === true ? 'FOR UPDATE' : '';
  const result = await executor.query(
    `
      SELECT plan_id, plan_scope, status, department_id
      FROM overtime_plans
      WHERE plan_id = $1
      LIMIT 1
      ${lockClause};
    `,
    [normalize(planId)]
  );

  if (result.rows.length === 0) {
    throw new AppError('Department OT Plan not found.', 404, 'PLAN_NOT_FOUND');
  }

  if ((result.rows[0].plan_scope || 'employee') !== 'department') {
    throw new AppError(
      'Only a Department OT Plan can be used as the purge target.',
      400,
      'PURGE_TARGET_NOT_DEPARTMENT_PLAN'
    );
  }

  return result.rows[0];
}

async function createPendingAudit(purgeData, actionByUser) {
  const result = await query(
    `
      INSERT INTO overtime_purge_audits (
        purge_audit_id,
        department_plan_id,
        performed_by,
        remarks,
        delete_source_employee_plans,
        status
      )
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *;
    `,
    [
      makeId('OTPURGE'),
      purgeData.planId,
      actionByUser.id,
      purgeData.remarks,
      purgeData.deleteSourceEmployeePlans,
    ]
  );

  return mapPurgeAudit(result.rows[0]);
}

async function markAuditFailed(purgeAuditId, error) {
  try {
    await query(
      `
        UPDATE overtime_purge_audits
        SET status = 'failed',
            error_message = $2,
            completed_at = NOW()
        WHERE purge_audit_id = $1;
      `,
      [
        purgeAuditId,
        normalize(error && error.message).slice(0, 1000) || 'OT data purge failed.',
      ]
    );
  } catch (auditError) {
    console.error('Unable to record OT purge failure.', auditError.message);
  }
}

async function getSourceEmployeePlanIds(departmentPlanId, executor) {
  const result = await executor.query(
    `
      SELECT DISTINCT source_employee_plan_id
      FROM overtime_plan_items
      WHERE plan_id = $1
        AND source_employee_plan_id IS NOT NULL
      ORDER BY source_employee_plan_id;
    `,
    [departmentPlanId]
  );
  return result.rows.map((row) => row.source_employee_plan_id);
}

async function ensureSourcePlansAreExclusive(departmentPlanId, sourcePlanIds, executor) {
  if (sourcePlanIds.length === 0) return;

  const result = await executor.query(
    `
      SELECT DISTINCT plan_id, source_employee_plan_id
      FROM overtime_plan_items
      WHERE source_employee_plan_id = ANY($1::TEXT[])
        AND plan_id <> $2
      LIMIT 1;
    `,
    [sourcePlanIds, departmentPlanId]
  );

  if (result.rows.length > 0) {
    throw new AppError(
      'A linked Employee OT Plan is also referenced by another Department OT Plan and cannot be purged.',
      409,
      'PURGE_SOURCE_PLAN_REFERENCED_ELSEWHERE'
    );
  }
}

async function scalarCount(executor, sql, values) {
  const result = await executor.query(sql, values);
  return Number(result.rows[0].count || 0);
}

async function collectDeletionCounts(departmentPlanId, sourcePlanIds, deleteSourcePlans, executor) {
  const planIds = deleteSourcePlans
    ? [departmentPlanId, ...sourcePlanIds]
    : [departmentPlanId];
  const actualPeriods = await scalarCount(
    executor,
    'SELECT COUNT(*)::INTEGER AS count FROM overtime_actual_periods WHERE source_department_plan_id = $1;',
    [departmentPlanId]
  );
  const actualEntries = await scalarCount(
    executor,
    `
      SELECT COUNT(*)::INTEGER AS count
      FROM overtime_actual_entries entry
      INNER JOIN overtime_actual_periods period ON period.actual_period_id = entry.actual_period_id
      WHERE period.source_department_plan_id = $1;
    `,
    [departmentPlanId]
  );
  const comments = await scalarCount(
    executor,
    `
      SELECT COUNT(*)::INTEGER AS count
      FROM overtime_actual_comments comment
      INNER JOIN overtime_actual_entries entry ON entry.actual_entry_id = comment.actual_entry_id
      INNER JOIN overtime_actual_periods period ON period.actual_period_id = entry.actual_period_id
      WHERE period.source_department_plan_id = $1;
    `,
    [departmentPlanId]
  );
  const adjustmentLogs = await scalarCount(
    executor,
    `
      SELECT COUNT(*)::INTEGER AS count
      FROM overtime_actual_adjustment_logs adjustment
      INNER JOIN overtime_actual_entries entry ON entry.actual_entry_id = adjustment.actual_entry_id
      INNER JOIN overtime_actual_periods period ON period.actual_period_id = entry.actual_period_id
      WHERE period.source_department_plan_id = $1;
    `,
    [departmentPlanId]
  );
  const actualDocumentMetadata = await scalarCount(
    executor,
    `
      SELECT COUNT(*)::INTEGER AS count
      FROM overtime_actual_documents document
      INNER JOIN overtime_actual_periods period ON period.actual_period_id = document.actual_period_id
      WHERE period.source_department_plan_id = $1;
    `,
    [departmentPlanId]
  );
  const planItems = await scalarCount(
    executor,
    'SELECT COUNT(*)::INTEGER AS count FROM overtime_plan_items WHERE plan_id = ANY($1::TEXT[]);',
    [planIds]
  );
  const planLogs = await scalarCount(
    executor,
    'SELECT COUNT(*)::INTEGER AS count FROM overtime_plan_logs WHERE plan_id = ANY($1::TEXT[]);',
    [planIds]
  );
  const approvalRecords = await scalarCount(
    executor,
    'SELECT COUNT(*)::INTEGER AS count FROM overtime_plan_approvals WHERE plan_id = ANY($1::TEXT[]);',
    [planIds]
  );
  const signatureRecords = await scalarCount(
    executor,
    'SELECT COUNT(*)::INTEGER AS count FROM overtime_plan_signature_records WHERE plan_id = ANY($1::TEXT[]);',
    [planIds]
  );
  const planDocumentMetadata = await scalarCount(
    executor,
    'SELECT COUNT(*)::INTEGER AS count FROM overtime_plan_documents WHERE plan_id = ANY($1::TEXT[]);',
    [planIds]
  );

  return {
    departmentPlans: 1,
    employeePlans: deleteSourcePlans ? sourcePlanIds.length : 0,
    planItems,
    planLogs,
    approvalRecords,
    signatureRecords,
    actualPeriods,
    actualEntries,
    comments,
    adjustmentLogs,
    documentMetadataRecords: actualDocumentMetadata + planDocumentMetadata,
  };
}

async function purgeOvertimeData(planId, purgeInput = {}, actionByUser) {
  const purgeData = validatePurgeRequest(planId, purgeInput, actionByUser);
  await getDepartmentPlanForPurge(purgeData.planId);
  const audit = await createPendingAudit(purgeData, actionByUser);

  try {
    const deleted = await transaction(async (client) => {
      await getDepartmentPlanForPurge(purgeData.planId, client, { lock: true });
      const sourcePlanIds = await getSourceEmployeePlanIds(purgeData.planId, client);

      if (purgeData.deleteSourceEmployeePlans) {
        await ensureSourcePlansAreExclusive(purgeData.planId, sourcePlanIds, client);
      }

      const counts = await collectDeletionCounts(
        purgeData.planId,
        sourcePlanIds,
        purgeData.deleteSourceEmployeePlans,
        client
      );

      await client.query(
        'DELETE FROM overtime_actual_periods WHERE source_department_plan_id = $1;',
        [purgeData.planId]
      );
      await client.query('DELETE FROM overtime_plans WHERE plan_id = $1;', [purgeData.planId]);

      if (purgeData.deleteSourceEmployeePlans && sourcePlanIds.length > 0) {
        await client.query(
          `
            DELETE FROM overtime_plans
            WHERE plan_id = ANY($1::TEXT[])
              AND COALESCE(plan_scope, 'employee') = 'employee';
          `,
          [sourcePlanIds]
        );
      }

      await client.query(
        `
          UPDATE overtime_purge_audits
          SET deleted_record_counts = $2::JSONB,
              excel_files_deleted = FALSE,
              status = 'completed',
              error_message = NULL,
              completed_at = NOW()
          WHERE purge_audit_id = $1;
        `,
        [audit.purgeAuditId, JSON.stringify(counts)]
      );

      return counts;
    });

    return {
      message: 'OT Plan and Actual OT data were permanently deleted. Excel files were retained in Supabase Storage.',
      purgeAuditId: audit.purgeAuditId,
      departmentPlanId: purgeData.planId,
      deleteSourceEmployeePlans: purgeData.deleteSourceEmployeePlans,
      deleted,
      excelFilesDeleted: false,
      excelFilesRetained: true,
    };
  } catch (error) {
    await markAuditFailed(audit.purgeAuditId, error);
    throw error;
  }
}

module.exports = {
  purgeOvertimeData,
  validatePurgeRequest,
};
