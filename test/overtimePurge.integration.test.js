const assert = require('node:assert/strict');
const test = require('node:test');

const { createPasswordHash } = require('../src/config/auth');
const { closePool, query } = require('../src/config/database');
const { createImpersonationSession, verifyToken } = require('../src/services/authService');
const { purgeOvertimeData } = require('../src/services/overtime/overtimePurgeService');
const { createEmployee, deleteEmployee, updateEmployee } = require('../src/services/overtime/employeeService');
const { deleteDepartment, updateDepartment } = require('../src/services/overtime/departmentService');
const { updateActualEntry } = require('../src/services/overtime/actualOvertimeService');
const {
  resetOvertimePlanStatus,
} = require('../src/services/overtime/departmentOtPlanWorkflowService');

const hasDatabase = Boolean(process.env.DATABASE_URL);

test('OT data purge deletes linked database records but keeps master data and signatures', {
  skip: !hasDatabase,
}, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ids = {
    adminUser: `QA-PURGE-ADMIN-${suffix}`,
    employeeUser: `QA-PURGE-USER-${suffix}`,
    department: `QA-PURGE-DEP-${suffix}`,
    employee: `QA-PURGE-EMP-${suffix}`,
    signature: `QA-PURGE-USERSIG-${suffix}`,
    employeePlan: `QA-PURGE-EMPPLAN-${suffix}`,
    employeeItem: `QA-PURGE-EMPITEM-${suffix}`,
    departmentPlan: `QA-PURGE-DEPTPLAN-${suffix}`,
    departmentItem: `QA-PURGE-DEPTITEM-${suffix}`,
    planLog: `QA-PURGE-LOG-${suffix}`,
    approval: `QA-PURGE-APPROVAL-${suffix}`,
    planSignature: `QA-PURGE-PLANSIG-${suffix}`,
    employeeDocument: `QA-PURGE-EMPDOC-${suffix}`,
    departmentDocument: `QA-PURGE-DEPTDOC-${suffix}`,
    actualPeriod: `QA-PURGE-PERIOD-${suffix}`,
    actualEntry: `QA-PURGE-ENTRY-${suffix}`,
    actualComment: `QA-PURGE-COMMENT-${suffix}`,
    actualAdjustment: `QA-PURGE-ADJUST-${suffix}`,
    actualDocument: `QA-PURGE-ACTUALDOC-${suffix}`,
    impersonationAudit: '',
  };
  let purgeAuditId;

  try {
    await query(
      `INSERT INTO users (id, first_name, last_name, email, password_hash, role, status)
       VALUES ($1, 'QA', 'Purge Admin', $2, $5, 'admin', 'active'),
              ($3, 'QA', 'Purge Employee', $4, 'test-only', 'user', 'active');`,
      [
        ids.adminUser,
        `qa-purge-admin-${suffix}@example.test`,
        ids.employeeUser,
        `qa-purge-user-${suffix}@example.test`,
        createPasswordHash('QA-Impersonation-Password-123!'),
      ]
    );
    await query(
      `INSERT INTO departments (department_id, department_name, status)
       VALUES ($1, 'QA Purge Department', 'active');`,
      [ids.department]
    );
    const createdEmployee = await createEmployee({
      userId: ids.employeeUser,
      departmentId: ids.department,
      position: 'QA Operator',
      shift: 'day',
      employmentType: 'regular',
    });
    ids.employee = createdEmployee.employee.employeeId;
    assert.equal(Object.hasOwn(createdEmployee.employee, 'dailyRate'), false);

    const impersonation = await createImpersonationSession(
      { id: ids.adminUser, role: 'admin' },
      {
        targetUserId: ids.employeeUser,
        adminPassword: 'QA-Impersonation-Password-123!',
        remarks: 'QA verification of audited Admin support access.',
      }
    );
    ids.impersonationAudit = impersonation.impersonation.auditId;
    assert.equal(impersonation.user.role, 'user');
    const impersonatedUser = await verifyToken(impersonation.token);
    assert.equal(impersonatedUser.id, ids.employeeUser);
    assert.equal(impersonatedUser.toJSON().impersonation.adminUserId, ids.adminUser);

    const updatedEmployee = await updateEmployee(ids.employee, {
      position: 'QA Updated Operator',
      dailyRate: 999,
    });
    assert.equal(updatedEmployee.employee.position, 'QA Updated Operator');
    assert.equal(Object.hasOwn(updatedEmployee.employee, 'dailyRate'), false);

    const dailyRateColumn = await query(
      `SELECT COUNT(*)::INTEGER AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'employees'
         AND column_name = 'daily_rate';`
    );
    assert.equal(dailyRateColumn.rows[0].count, 0);
    await query(
      `INSERT INTO user_signatures (
         signature_id, user_id, uploaded_by, signature_file_path, mime_type, status
       ) VALUES ($1, $2, $3, $4, 'image/png', 'active');`,
      [
        ids.signature,
        ids.employeeUser,
        ids.adminUser,
        `users/${ids.employeeUser}/signature.png`,
      ]
    );
    await query(
      `INSERT INTO overtime_plans (
         plan_id, department_id, period_type, period_start_date, period_end_date,
         status, plan_scope, created_by
       ) VALUES
         ($1, $3, 'weekly', '2026-08-03', '2026-08-09', 'approved', 'employee', $4),
         ($2, $3, 'weekly', '2026-08-03', '2026-08-09', 'approved', 'department', $4);`,
      [ids.employeePlan, ids.departmentPlan, ids.department, ids.adminUser]
    );
    await query(
      `INSERT INTO overtime_plan_items (
         plan_item_id, plan_id, employee_id, planned_date, planned_hours, reason,
         source_employee_plan_id
       ) VALUES
         ($1, $2, $5, '2026-08-05', 2.5, 'QA source item', NULL),
         ($3, $4, $5, '2026-08-05', 2.5, 'QA department item', $2);`,
      [
        ids.employeeItem,
        ids.employeePlan,
        ids.departmentItem,
        ids.departmentPlan,
        ids.employee,
      ]
    );
    await query(
      `INSERT INTO overtime_plan_logs (log_id, plan_id, action, action_by, remarks)
       VALUES ($1, $2, 'qa_purge_test', $3, 'QA purge integration fixture');`,
      [ids.planLog, ids.departmentPlan, ids.adminUser]
    );
    await query(
      `INSERT INTO overtime_plan_approvals (
         approval_id, plan_id, step_order, step_name, approver_role, approver_user_id,
         status, acted_by, acted_at, signature_file_path, signature_mime_type
       ) VALUES ($1, $2, 1, 'QA Final Approval', 'admin', $3, 'approved', $3, NOW(), $4, 'image/png');`,
      [
        ids.approval,
        ids.departmentPlan,
        ids.adminUser,
        `users/${ids.adminUser}/signature.png`,
      ]
    );
    await query(
      `INSERT INTO overtime_plan_signature_records (
         signature_record_id, plan_id, employee_id, signature_owner_user_id,
         acted_by_user_id, signer_role, confirmation_method, signature_file_path,
         signature_mime_type, remarks, status
       ) VALUES ($1, $2, $3, $4, $4, 'employee', 'self', $5, 'image/png', 'QA signed', 'active');`,
      [
        ids.planSignature,
        ids.employeePlan,
        ids.employee,
        ids.employeeUser,
        `users/${ids.employeeUser}/signature.png`,
      ]
    );
    await query(
      `INSERT INTO overtime_plan_documents (
         document_id, plan_id, file_path, generated_by, generated_at, status
       ) VALUES
         ($1, $3, $5, $6, NOW(), 'ready'),
         ($2, $4, $7, $6, NOW(), 'ready');`,
      [
        ids.employeeDocument,
        ids.departmentDocument,
        ids.employeePlan,
        ids.departmentPlan,
        `final-documents/${ids.employeePlan}.xlsx`,
        ids.adminUser,
        `final-documents/${ids.departmentPlan}.xlsx`,
      ]
    );
    await query(
      `INSERT INTO overtime_actual_periods (
         actual_period_id, source_department_plan_id, department_id, period_type,
         period_start_date, period_end_date, status, created_by
       ) VALUES ($1, $2, $3, 'weekly', '2026-08-03', '2026-08-09', 'open', $4);`,
      [ids.actualPeriod, ids.departmentPlan, ids.department, ids.adminUser]
    );
    await query(
      `INSERT INTO overtime_actual_entries (
         actual_entry_id, actual_period_id, source_plan_item_id, source_employee_plan_id,
         employee_id, actual_date, planned_hours, actual_hours, planned_reason
       ) VALUES ($1, $2, $3, $4, $5, '2026-08-05', 2.5, 2.5, 'QA actual entry');`,
      [
        ids.actualEntry,
        ids.actualPeriod,
        ids.departmentItem,
        ids.employeePlan,
        ids.employee,
      ]
    );
    await query(
      `INSERT INTO overtime_actual_comments (comment_id, actual_entry_id, user_id, remarks)
       VALUES ($1, $2, $3, 'QA employee comment');`,
      [ids.actualComment, ids.actualEntry, ids.employeeUser]
    );
    const adjustedEntry = await updateActualEntry(
      ids.actualEntry,
      { actualHours: 2, remarks: 'QA timekeeping adjustment' },
      { id: ids.adminUser, role: 'admin' }
    );
    assert.equal(adjustedEntry.actualHours, 2);
    assert.equal(Object.hasOwn(adjustedEntry, 'actualStartTime'), false);
    assert.equal(Object.hasOwn(adjustedEntry, 'actualEndTime'), false);

    const removedTimeColumns = await query(
      `SELECT COUNT(*)::INTEGER AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'overtime_actual_entries'
             AND column_name IN ('actual_start_time', 'actual_end_time'))
           OR
           (table_name = 'overtime_actual_adjustment_logs'
             AND column_name IN (
               'previous_start_time', 'new_start_time',
               'previous_end_time', 'new_end_time'
             ))
         );`
    );
    assert.equal(removedTimeColumns.rows[0].count, 0);
    await query(
      `INSERT INTO overtime_actual_documents (
         document_id, actual_period_id, file_path, generated_by, generated_at, status
       ) VALUES ($1, $2, $3, $4, NOW(), 'ready');`,
      [
        ids.actualDocument,
        ids.actualPeriod,
        `actual-overtime/${ids.actualPeriod}.xlsx`,
        ids.adminUser,
      ]
    );

    await assert.rejects(
      deleteEmployee(ids.employee),
      (error) => error.code === 'EMPLOYEE_DELETE_REFERENCED'
    );
    await assert.rejects(
      deleteDepartment(ids.department),
      (error) => error.code === 'DEPARTMENT_DELETE_REFERENCED'
    );

    await assert.rejects(
      resetOvertimePlanStatus(
        ids.departmentPlan,
        { id: ids.adminUser, role: 'admin' },
        { newStatus: 'draft', remarks: 'QA reset guard check.' }
      ),
      (error) => error.code === 'PLAN_HAS_ACTUAL_OVERTIME'
    );

    const result = await purgeOvertimeData(
      ids.departmentPlan,
      {
        confirmPlanId: ids.departmentPlan,
        remarks: 'QA integration test purge.',
        deleteSourceEmployeePlans: true,
        confirmKeepExcel: true,
      },
      { id: ids.adminUser, role: 'admin' }
    );
    purgeAuditId = result.purgeAuditId;

    assert.equal(result.excelFilesDeleted, false);
    assert.equal(result.excelFilesRetained, true);
    assert.deepEqual(result.deleted, {
      departmentPlans: 1,
      employeePlans: 1,
      planItems: 2,
      planLogs: 1,
      approvalRecords: 1,
      signatureRecords: 1,
      actualPeriods: 1,
      actualEntries: 1,
      comments: 1,
      adjustmentLogs: 1,
      documentMetadataRecords: 3,
    });

    const deletedRows = await query(
      `SELECT
         (SELECT COUNT(*)::INTEGER FROM overtime_plans WHERE plan_id = ANY($1::TEXT[])) AS plans,
         (SELECT COUNT(*)::INTEGER FROM overtime_actual_periods WHERE actual_period_id = $2) AS periods,
         (SELECT COUNT(*)::INTEGER FROM overtime_plan_documents WHERE document_id = ANY($3::TEXT[])) AS plan_documents,
         (SELECT COUNT(*)::INTEGER FROM overtime_actual_documents WHERE document_id = $4) AS actual_documents;`,
      [
        [ids.departmentPlan, ids.employeePlan],
        ids.actualPeriod,
        [ids.departmentDocument, ids.employeeDocument],
        ids.actualDocument,
      ]
    );
    assert.deepEqual(deletedRows.rows[0], {
      plans: 0,
      periods: 0,
      plan_documents: 0,
      actual_documents: 0,
    });

    const retainedRows = await query(
      `SELECT
         (SELECT COUNT(*)::INTEGER FROM users WHERE id = ANY($1::TEXT[])) AS users,
         (SELECT COUNT(*)::INTEGER FROM departments WHERE department_id = $2) AS departments,
         (SELECT COUNT(*)::INTEGER FROM employees WHERE employee_id = $3) AS employees,
         (SELECT COUNT(*)::INTEGER FROM user_signatures WHERE signature_id = $4) AS signatures;`,
      [[ids.adminUser, ids.employeeUser], ids.department, ids.employee, ids.signature]
    );
    assert.deepEqual(retainedRows.rows[0], {
      users: 2,
      departments: 1,
      employees: 1,
      signatures: 1,
    });

    const auditResult = await query(
      `SELECT status, excel_files_deleted, deleted_record_counts
       FROM overtime_purge_audits
       WHERE purge_audit_id = $1;`,
      [purgeAuditId]
    );
    assert.equal(auditResult.rows[0].status, 'completed');
    assert.equal(auditResult.rows[0].excel_files_deleted, false);
    assert.equal(auditResult.rows[0].deleted_record_counts.actualEntries, 1);

    const updatedDepartment = await updateDepartment(ids.department, {
      departmentName: 'QA Updated Department',
      status: 'inactive',
    });
    assert.equal(updatedDepartment.department.departmentName, 'QA Updated Department');
    assert.equal(updatedDepartment.department.status, 'inactive');

    const deletedEmployee = await deleteEmployee(ids.employee);
    assert.equal(deletedEmployee.employee.employeeId, ids.employee);
    assert.equal(deletedEmployee.userAccountRetained, true);
    const retainedUser = await query('SELECT COUNT(*)::INTEGER AS count FROM users WHERE id = $1;', [ids.employeeUser]);
    assert.equal(retainedUser.rows[0].count, 1);

    const deletedDepartment = await deleteDepartment(ids.department);
    assert.equal(deletedDepartment.department.departmentId, ids.department);
  } finally {
    await query('DELETE FROM overtime_actual_periods WHERE actual_period_id = $1;', [ids.actualPeriod]);
    await query('DELETE FROM overtime_plans WHERE plan_id = $1;', [ids.departmentPlan]);
    await query('DELETE FROM overtime_plans WHERE plan_id = $1;', [ids.employeePlan]);
    if (purgeAuditId) {
      await query('DELETE FROM overtime_purge_audits WHERE purge_audit_id = $1;', [purgeAuditId]);
    }
    if (ids.impersonationAudit) {
      await query('DELETE FROM admin_impersonation_audits WHERE impersonation_audit_id = $1;', [ids.impersonationAudit]);
    }
    await query('DELETE FROM user_signatures WHERE signature_id = $1;', [ids.signature]);
    await query('DELETE FROM employees WHERE employee_id = $1;', [ids.employee]);
    await query('DELETE FROM departments WHERE department_id = $1;', [ids.department]);
    await query('DELETE FROM users WHERE id = ANY($1::TEXT[]);', [[ids.adminUser, ids.employeeUser]]);
    await closePool();
  }
});
