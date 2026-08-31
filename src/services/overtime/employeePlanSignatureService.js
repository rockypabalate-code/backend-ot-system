const crypto = require('crypto');
const { query, transaction } = require('../../config/database');
const AppError = require('../../utils/appError');
const { getUserSignature } = require('../signatureService');
const { getEmployeeById, getEmployeeByUserId } = require('./employeeService');
const { addPlanLog, getOvertimePlan } = require('./overtimePlanService');
const {
  submitEmployeePlanToSupervisorWithExecutor,
} = require('./departmentOtPlanWorkflowService');

function normalize(value) {
  return String(value || '').trim();
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function mapPlanSignatureRecord(row) {
  return {
    signatureRecordId: row.signature_record_id,
    planId: row.plan_id,
    employeeId: row.employee_id,
    signatureOwnerUserId: row.signature_owner_user_id,
    actedByUserId: row.acted_by_user_id,
    signerRole: row.signer_role,
    confirmationMethod: row.confirmation_method,
    signatureFilePath: row.signature_file_path,
    signatureMimeType: row.signature_mime_type || '',
    signedAt: iso(row.signed_at),
    remarks: row.remarks || '',
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function buildFullName(row) {
  return [row.employee_first_name, row.employee_middle_name, row.employee_last_name]
    .map(normalize)
    .filter(Boolean)
    .join(' ');
}

async function getActiveEmployeePlanSignature(planId, employeeId, executor = { query }) {
  const result = await executor.query(
    `
      SELECT *
      FROM overtime_plan_signature_records
      WHERE plan_id = $1
        AND employee_id = $2
        AND status = 'active'
      LIMIT 1;
    `,
    [normalize(planId), normalize(employeeId)]
  );

  return result.rows[0] ? mapPlanSignatureRecord(result.rows[0]) : null;
}

async function getDepartmentPlanEmployeeSignatures(planId, executor = { query }) {
  const result = await executor.query(
    `
      SELECT DISTINCT ON (opi.source_employee_plan_id, opi.employee_id)
        signature_record.*,
        opi.source_employee_plan_id,
        e.employee_no,
        u.first_name AS employee_first_name,
        u.middle_name AS employee_middle_name,
        u.last_name AS employee_last_name
      FROM overtime_plan_items opi
      INNER JOIN overtime_plans source_plan
        ON source_plan.plan_id = opi.source_employee_plan_id
       AND COALESCE(source_plan.plan_scope, 'employee') = 'employee'
       AND source_plan.status = 'supervisor_accepted'
      INNER JOIN overtime_plan_signature_records signature_record
        ON signature_record.plan_id = opi.source_employee_plan_id
       AND signature_record.employee_id = opi.employee_id
       AND signature_record.status = 'active'
      INNER JOIN employees e ON e.employee_id = opi.employee_id
      INNER JOIN users u ON u.id = e.user_id
      WHERE opi.plan_id = $1
      ORDER BY
        opi.source_employee_plan_id,
        opi.employee_id,
        signature_record.signed_at DESC;
    `,
    [normalize(planId)]
  );

  return result.rows.map((row) => ({
    ...mapPlanSignatureRecord(row),
    sourceEmployeePlanId: row.source_employee_plan_id,
    employeeNo: row.employee_no || '',
    employeeName: buildFullName(row),
  }));
}

async function resolveSigningContext(plan, actionByUser, body, executor) {
  if (actionByUser.role === 'user') {
    const employee = await getEmployeeByUserId(actionByUser.id, executor);

    if (!employee) {
      throw new AppError(
        'Your account is not linked to an employee profile.',
        403,
        'EMPLOYEE_PROFILE_REQUIRED'
      );
    }

    if (body.employeeId && normalize(body.employeeId) !== employee.employeeId) {
      throw new AppError(
        'You can only sign your own employee overtime plan.',
        403,
        'EMPLOYEE_SIGNATURE_FORBIDDEN'
      );
    }

    return {
      employee,
      confirmationMethod: 'self',
      signerRole: 'employee',
    };
  }

  if (actionByUser.role !== 'supervisor') {
    throw new AppError(
      'Only an employee or assigned supervisor can sign an employee overtime plan.',
      403,
      'PLAN_SIGNATURE_FORBIDDEN'
    );
  }

  const employeeId = normalize(body.employeeId);
  const remarks = normalize(body.remarks);

  if (!employeeId) {
    throw new AppError(
      'Employee ID is required when signing on behalf of an employee.',
      400,
      'EMPLOYEE_REQUIRED'
    );
  }

  if (!remarks) {
    throw new AppError(
      'Remarks describing the employee agreement are required.',
      400,
      'ON_BEHALF_REMARKS_REQUIRED'
    );
  }

  const supervisorEmployee = await getEmployeeByUserId(actionByUser.id, executor);
  const employee = await getEmployeeById(employeeId, executor);

  if (!supervisorEmployee) {
    throw new AppError(
      'Your supervisor account is not linked to an employee profile.',
      403,
      'SUPERVISOR_EMPLOYEE_PROFILE_REQUIRED'
    );
  }

  if (!employee) {
    throw new AppError('Employee not found.', 404, 'EMPLOYEE_NOT_FOUND');
  }

  if (
    employee.departmentId !== plan.departmentId
    || supervisorEmployee.departmentId !== plan.departmentId
    || employee.supervisorUserId !== actionByUser.id
  ) {
    throw new AppError(
      'You may sign only for an employee assigned to you in your department.',
      403,
      'SUPERVISOR_EMPLOYEE_SIGNATURE_FORBIDDEN'
    );
  }

  return {
    employee,
    confirmationMethod: 'supervisor_on_behalf',
    signerRole: 'supervisor',
  };
}

async function signEmployeeOvertimePlanWithExecutor(planId, actionByUser, body = {}, executor) {
    await executor.query(
      'SELECT plan_id FROM overtime_plans WHERE plan_id = $1 FOR UPDATE;',
      [normalize(planId)]
    );

    const plan = await getOvertimePlan(planId, {}, executor);

    if (!plan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    if ((plan.planScope || 'employee') !== 'employee') {
      throw new AppError(
        'Only employee overtime plans can receive an employee signature.',
        400,
        'PLAN_SCOPE_NOT_EMPLOYEE'
      );
    }

    if (plan.status !== 'submitted_to_supervisor') {
      throw new AppError(
        'The employee overtime plan must be submitted to the supervisor before it can be signed.',
        400,
        'PLAN_NOT_READY_FOR_SIGNATURE'
      );
    }

    const context = await resolveSigningContext(plan, actionByUser, body || {}, executor);
    const belongsToPlan = plan.items.some((item) => item.employeeId === context.employee.employeeId);

    if (!belongsToPlan) {
      throw new AppError(
        'The employee is not included in this overtime plan.',
        400,
        'EMPLOYEE_NOT_IN_PLAN'
      );
    }

    if (context.employee.status !== 'active' || context.employee.userStatus !== 'active') {
      throw new AppError(
        'The employee and linked user account must be active.',
        400,
        'EMPLOYEE_NOT_ACTIVE'
      );
    }

    const savedSignature = await getUserSignature(context.employee.userId, executor);

    if (!savedSignature) {
      throw new AppError(
        'The employee must save a signature before confirming this overtime plan.',
        400,
        'SIGNATURE_REQUIRED'
      );
    }

    await executor.query(
      `
        UPDATE overtime_plan_signature_records
        SET status = 'superseded',
            updated_at = NOW()
        WHERE plan_id = $1
          AND employee_id = $2
          AND status = 'active';
      `,
      [plan.planId, context.employee.employeeId]
    );

    const result = await executor.query(
      `
        INSERT INTO overtime_plan_signature_records (
          signature_record_id,
          plan_id,
          employee_id,
          signature_owner_user_id,
          acted_by_user_id,
          signer_role,
          confirmation_method,
          signature_file_path,
          signature_mime_type,
          remarks,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
        RETURNING *;
      `,
      [
        `PLANSIGNATURE-${crypto.randomUUID()}`,
        plan.planId,
        context.employee.employeeId,
        context.employee.userId,
        actionByUser.id,
        context.signerRole,
        context.confirmationMethod,
        savedSignature.signatureFilePath,
        savedSignature.mimeType,
        normalize(body.remarks) || null,
      ]
    );

    const logAction = context.confirmationMethod === 'self'
      ? 'employee_plan_signed_self'
      : 'employee_plan_signed_by_supervisor_on_behalf';
    const defaultRemarks = context.confirmationMethod === 'self'
      ? 'Employee confirmed and signed the overtime plan.'
      : 'Supervisor confirmed the overtime plan on behalf of the employee.';

    await addPlanLog(
      plan.planId,
      logAction,
      actionByUser.id,
      normalize(body.remarks) || defaultRemarks,
      executor
    );

    return {
      plan: await getOvertimePlan(plan.planId, {}, executor),
      signatureRecord: mapPlanSignatureRecord(result.rows[0]),
    };
}

async function signEmployeeOvertimePlan(planId, actionByUser, body = {}) {
  return transaction(async (client) => {
    return signEmployeeOvertimePlanWithExecutor(planId, actionByUser, body, client);
  });
}

async function submitAndSignEmployeeOvertimePlan(planId, actionByUser, body = {}) {
  if (!actionByUser || actionByUser.role !== 'user') {
    throw new AppError(
      'Only an employee can submit and sign their own overtime plan.',
      403,
      'PLAN_SUBMIT_AND_SIGN_FORBIDDEN'
    );
  }

  return transaction(async (client) => {
    const existingPlan = await getOvertimePlan(planId, {}, client);

    if (!existingPlan) {
      throw new AppError('Overtime plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    if (existingPlan.createdBy !== actionByUser.id) {
      throw new AppError(
        'You can only submit and sign an overtime plan that you created.',
        403,
        'PLAN_SUBMIT_AND_SIGN_FORBIDDEN'
      );
    }

    const submissionRemarks = body.submissionRemarks || body.remarks;
    const signatureRemarks = body.signatureRemarks || body.remarks;

    await submitEmployeePlanToSupervisorWithExecutor(
      planId,
      actionByUser.id,
      submissionRemarks,
      client
    );

    return signEmployeeOvertimePlanWithExecutor(
      planId,
      actionByUser,
      { remarks: signatureRemarks },
      client
    );
  });
}

async function withdrawEmployeeOvertimePlan(planId, actionByUser, body = {}) {
  if (!actionByUser || actionByUser.role !== 'user') {
    throw new AppError(
      'Only an employee can withdraw their submitted overtime plan.',
      403,
      'PLAN_WITHDRAW_FORBIDDEN'
    );
  }

  const remarks = normalize(body.remarks || body.reason);

  if (!remarks) {
    throw new AppError(
      'Remarks are required when withdrawing an overtime plan.',
      400,
      'PLAN_WITHDRAW_REMARKS_REQUIRED'
    );
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

    if ((plan.planScope || 'employee') !== 'employee' || plan.createdBy !== actionByUser.id) {
      throw new AppError(
        'You can only withdraw an employee overtime plan that you created.',
        403,
        'PLAN_WITHDRAW_FORBIDDEN'
      );
    }

    if (plan.status !== 'submitted_to_supervisor') {
      throw new AppError(
        'Only a plan waiting for supervisor review can be withdrawn.',
        400,
        'PLAN_WITHDRAW_NOT_ALLOWED'
      );
    }

    await client.query(
      `
        UPDATE overtime_plan_signature_records
        SET status = 'superseded',
            updated_at = NOW()
        WHERE plan_id = $1
          AND status = 'active';
      `,
      [plan.planId]
    );
    await client.query(
      `
        UPDATE overtime_plans
        SET status = 'draft',
            submitted_by = NULL,
            submitted_at = NULL,
            rejection_reason = NULL,
            updated_at = NOW()
        WHERE plan_id = $1;
      `,
      [plan.planId]
    );
    await addPlanLog(
      plan.planId,
      'submission_withdrawn',
      actionByUser.id,
      remarks,
      client
    );

    return getOvertimePlan(plan.planId, {}, client);
  });
}

module.exports = {
  getActiveEmployeePlanSignature,
  getDepartmentPlanEmployeeSignatures,
  signEmployeeOvertimePlan,
  signEmployeeOvertimePlanWithExecutor,
  submitAndSignEmployeeOvertimePlan,
  withdrawEmployeeOvertimePlan,
};
