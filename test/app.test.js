const assert = require('node:assert/strict');
const test = require('node:test');
const ExcelJS = require('exceljs');

const app = require('../src/app');
const AppError = require('../src/utils/appError');
const authService = require('../src/services/authService');
const signatureService = require('../src/services/signatureService');
const notificationService = require('../src/services/notificationService');
const overtimeService = require('../src/services/overtimeDbService');
const adminController = require('../src/controllers/adminController');
const departmentWorkflowController = require('../src/controllers/overtime/departmentOtPlanWorkflowController');
const { buildFinalDocumentWorkbook } = require('../src/services/overtime/finalDocumentService');
const { buildActualOvertimeWorkbook } = require('../src/services/overtime/actualOvertimeDocumentService');
const {
  addActualActivity,
  addActualEntryComment,
  finalizeActualPeriod,
  getActualEntryMetrics,
  updateActualEntry,
} = require('../src/services/overtime/actualOvertimeService');
const { generateActualDocument } = require('../src/services/overtime/actualOvertimeDocumentService');
const { validatePurgeRequest } = require('../src/services/overtime/overtimePurgeService');

async function withServer(callback) {
  const server = app.listen(0);

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

test('GET / returns API route metadata', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.message, 'Backend API is running.');
    assert.equal(body.routes.login, 'POST /api/auth/login');
    assert.equal(body.routes.actualOvertime, 'GET /api/overtime/actual-periods/:actualPeriodId');
  });
});

test('unknown routes return JSON 404', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missing-route`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(body, { message: 'Route not found.' });
  });
});

test('CORS preflight returns 204 with configured headers', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      method: 'OPTIONS',
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(
      response.headers.get('access-control-allow-methods'),
      /GET,POST,PUT,PATCH,DELETE,OPTIONS/
    );
  });
});

test('protected routes require a bearer token', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/me`);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { message: 'Authentication token is required.' });
  });
});

test('notification routes require a bearer token', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/notifications`);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { message: 'Authentication token is required.' });
  });
});

test('an authenticated user can list only their notifications', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalListNotifications = notificationService.listNotifications;

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-notification-test', role: 'user', status: 'active' };
    },
  });
  notificationService.listNotifications = async (userId, options) => {
    assert.equal(userId, 'user-notification-test');
    assert.equal(options.unreadOnly, true);
    assert.equal(options.limit, '10');
    assert.equal(options.offset, '2');
    return {
      notifications: [{ notificationId: 'NOTIFICATION-TEST', planId: 'PLAN-TEST' }],
      pagination: { limit: 10, offset: 2, total: 1 },
      unreadCount: 1,
    };
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/notifications?unreadOnly=true&limit=10&offset=2`, {
        headers: { Authorization: 'Bearer notification-token' },
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.notifications[0].notificationId, 'NOTIFICATION-TEST');
      assert.equal(body.unreadCount, 1);
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    notificationService.listNotifications = originalListNotifications;
  }
});

test('an authenticated user can mark their notification as read', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalMarkNotificationRead = notificationService.markNotificationRead;

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-notification-test', role: 'user', status: 'active' };
    },
  });
  notificationService.markNotificationRead = async (notificationId, userId) => {
    assert.equal(notificationId, 'NOTIFICATION-TEST');
    assert.equal(userId, 'user-notification-test');
    return {
      notificationId,
      recipientUserId: userId,
      readAt: '2026-08-17T00:00:00.000Z',
    };
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/notifications/NOTIFICATION-TEST/read`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer notification-token' },
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.notification.notificationId, 'NOTIFICATION-TEST');
      assert.ok(body.notification.readAt);
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    notificationService.markNotificationRead = originalMarkNotificationRead;
  }
});

test('an authenticated user can mark Actual OT period notifications as read', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalMarkActualPeriod = notificationService.markActualPeriodNotificationsRead;

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-notification-test', role: 'user', status: 'active' };
    },
  });
  notificationService.markActualPeriodNotificationsRead = async (actualPeriodId, userId) => {
    assert.equal(actualPeriodId, 'ACTUALPERIOD-TEST');
    assert.equal(userId, 'user-notification-test');
    return 2;
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/notifications/actual-periods/ACTUALPERIOD-TEST/read`,
        {
          method: 'PATCH',
          headers: { Authorization: 'Bearer notification-token' },
        }
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body, { updatedCount: 2 });
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    notificationService.markActualPeriodNotificationsRead = originalMarkActualPeriod;
  }
});

test('adding an overtime plan log also creates its notifications', async () => {
  const originalCreateNotifications = notificationService.createPlanLogNotifications;
  const queries = [];
  let notificationInput;
  const executor = {
    async query(statement, values) {
      queries.push({ statement, values });
      return { rows: [{ log_id: 'PLANLOG-TEST' }] };
    },
  };

  notificationService.createPlanLogNotifications = async (input, receivedExecutor) => {
    notificationInput = input;
    assert.equal(receivedExecutor, executor);
    return [];
  };

  try {
    const log = await overtimeService.addPlanLog(
      'PLAN-TEST',
      'item_updated',
      'user-actor',
      'Plan entry updated.',
      executor
    );

    assert.equal(log.log_id, 'PLANLOG-TEST');
    assert.equal(queries.length, 1);
    assert.deepEqual(notificationInput, {
      planId: 'PLAN-TEST',
      logId: 'PLANLOG-TEST',
      action: 'item_updated',
      actionBy: 'user-actor',
      remarks: 'Plan entry updated.',
    });
  } finally {
    notificationService.createPlanLogNotifications = originalCreateNotifications;
  }
});

test('plan-log notification SQL gives the log ID parameter an explicit type', async () => {
  let capturedStatement = '';
  const executor = {
    async query(statement) {
      capturedStatement = statement;
      return { rows: [] };
    },
  };

  await notificationService.createPlanLogNotifications({
    planId: 'PLAN-TEST',
    logId: 'PLANLOG-TEST',
    action: 'created',
    actionBy: 'user-test',
    remarks: 'Overtime plan created.',
  }, executor);

  assert.match(capturedStatement, /\$3::TEXT/);
});

test('Actual OT activity creates target-aware notifications through the same transaction', async () => {
  const originalCreateNotifications = notificationService.createActualOvertimeNotifications;
  let notificationInput;
  const executor = {
    async query(statement, values) {
      assert.match(statement, /INSERT INTO overtime_actual_activity_logs/);
      assert.equal(values[1], 'ACTUALPERIOD-TEST');
      assert.equal(values[2], 'ACTUALENTRY-TEST');
      return { rows: [{ activity_id: 'ACTUALACTIVITY-TEST' }] };
    },
  };

  notificationService.createActualOvertimeNotifications = async (input, receivedExecutor) => {
    notificationInput = input;
    assert.equal(receivedExecutor, executor);
    return [];
  };

  try {
    const activity = await addActualActivity({
      actualPeriodId: 'ACTUALPERIOD-TEST',
      actualEntryId: 'ACTUALENTRY-TEST',
      action: 'actual_hours_updated',
      actionBy: 'user-supervisor',
      remarks: 'Matched timekeeping.',
    }, executor);

    assert.equal(activity.activity_id, 'ACTUALACTIVITY-TEST');
    assert.deepEqual(notificationInput, {
      actualPeriodId: 'ACTUALPERIOD-TEST',
      actualEntryId: 'ACTUALENTRY-TEST',
      activityId: 'ACTUALACTIVITY-TEST',
      action: 'actual_hours_updated',
      actionBy: 'user-supervisor',
      remarks: 'Matched timekeeping.',
    });
  } finally {
    notificationService.createActualOvertimeNotifications = originalCreateNotifications;
  }
});

test('Actual OT notification SQL targets employees, supervisors, and immutable activities', async () => {
  let capturedStatement = '';
  let capturedValues = [];
  const executor = {
    async query(statement, values) {
      capturedStatement = statement;
      capturedValues = values;
      return { rows: [] };
    },
  };

  await notificationService.createActualOvertimeNotifications({
    actualPeriodId: 'ACTUALPERIOD-TEST',
    actualEntryId: 'ACTUALENTRY-TEST',
    activityId: 'ACTUALACTIVITY-TEST',
    action: 'actual_comment_added',
    actionBy: 'user-employee',
    remarks: 'Please verify this entry.',
  }, executor);

  assert.match(capturedStatement, /actual_entry\.employee_id/);
  assert.match(capturedStatement, /employee\.supervisor_user_id/);
  assert.match(capturedStatement, /actual_activity_id/);
  assert.match(capturedStatement, /ON CONFLICT DO NOTHING/);
  assert.deepEqual(capturedValues, [
    'ACTUALPERIOD-TEST',
    'ACTUALENTRY-TEST',
    'user-employee',
    'ACTUALACTIVITY-TEST',
    'actual_comment_added',
    'New actual overtime comment',
    'Please verify this entry.',
  ]);
});

test('signature routes require a bearer token', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/users/signature`);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { message: 'Authentication token is required.' });
  });
});

test('an employee can retrieve only their own employee profile', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalGetEmployeeByUserId = overtimeService.getEmployeeByUserId;
  const employee = {
    employeeId: 'EMP-TEST',
    userId: 'user-test',
    employeeNo: 'EMP-001',
    fullName: 'Test Employee',
    departmentName: 'Engineering',
  };

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-test', role: 'user', status: 'active' };
    },
  });
  overtimeService.getEmployeeByUserId = async (userId) => {
    assert.equal(userId, 'user-test');
    return employee;
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/overtime/employees/me`, {
        headers: { Authorization: 'Bearer employee-token' },
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body, { employee });
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    overtimeService.getEmployeeByUserId = originalGetEmployeeByUserId;
  }
});

test('an employee calendar summary includes scoped daily plan statuses', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalGetEmployeeByUserId = overtimeService.getEmployeeByUserId;
  const originalGetCalendar = overtimeService.getOvertimePlanCalendarSummary;
  const calendar = [{
    date: '2026-08-19',
    itemCount: 1,
    employeeCount: 1,
    planCount: 1,
    plannedHours: 4,
    statuses: ['submitted_to_supervisor'],
  }];

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-test', role: 'user', status: 'active' };
    },
  });
  overtimeService.getEmployeeByUserId = async () => ({ employeeId: 'EMP-TEST' });
  overtimeService.getOvertimePlanCalendarSummary = async (filters) => {
    assert.equal(filters.employeeId, 'EMP-TEST');
    assert.equal(filters.dateFrom, '2026-08-01');
    assert.equal(filters.dateTo, '2026-08-31');
    return calendar;
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/overtime/plans/calendar?dateFrom=2026-08-01&dateTo=2026-08-31`,
        { headers: { Authorization: 'Bearer employee-token' } }
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body, { calendar });
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    overtimeService.getEmployeeByUserId = originalGetEmployeeByUserId;
    overtimeService.getOvertimePlanCalendarSummary = originalGetCalendar;
  }
});

test('employee plan list and calendar show one lifecycle plan before and after final approval', async () => {
  const statements = [];
  const executor = {
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  };

  await overtimeService.getOvertimePlans({
    collapseFinalizedSources: true,
    userId: 'user-employee',
    userAccessibleEmployeeId: 'EMPLOYEE-TEST',
  }, executor);
  await overtimeService.getOvertimePlanCalendarSummary({
    collapseFinalizedSources: true,
    employeeId: 'EMPLOYEE-TEST',
  }, executor);

  assert.equal(statements.length, 2);
  assert.match(statements[0], /COALESCE\(op\.plan_scope, 'employee'\) = 'employee'/);
  assert.match(statements[0], /COALESCE\(op\.plan_scope, 'employee'\) = 'department'/);
  assert.match(statements[0], /canonical_item\.source_employee_plan_id = op\.plan_id/);
  assert.match(statements[0], /canonical_plan\.status IN \('approved', 'closed'\)/);
  assert.match(statements[1], /COALESCE\(op\.plan_scope, 'employee'\) = 'department'/);
  assert.match(statements[1], /op\.status IN \('approved', 'closed'\)/);
  assert.match(statements[1], /canonical_item\.source_employee_plan_id = op\.plan_id/);
  assert.match(statements[1], /canonical_item\.planned_date = opi\.planned_date/);
  assert.match(statements[1], /canonical_plan\.status IN \('approved', 'closed'\)/);
});

test('only an admin role can upload signature images', async () => {
  const originalVerifyToken = authService.verifyToken;
  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-test', role: 'user', status: 'active' };
    },
  });

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/users/signature`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-user-token',
        },
      });
      const body = await response.json();

      assert.equal(response.status, 403);
      assert.deepEqual(body, { message: 'You do not have permission to access this resource.' });
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
  }
});

test('Admin management routes expose department, employee, signature, and impersonation actions', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalUpdateDepartment = overtimeService.updateDepartment;
  const originalDeleteDepartment = overtimeService.deleteDepartment;
  const originalDeleteEmployee = overtimeService.deleteEmployee;
  const originalDeleteSignature = signatureService.deleteUserSignature;
  const originalImpersonate = authService.createImpersonationSession;

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-admin', role: 'admin', status: 'active' };
    },
  });
  overtimeService.updateDepartment = async (departmentId) => ({ department: { departmentId } });
  overtimeService.deleteDepartment = async (departmentId) => ({ department: { departmentId } });
  overtimeService.deleteEmployee = async (employeeId) => ({ employee: { employeeId }, userAccountRetained: true });
  signatureService.deleteUserSignature = async (userId) => ({ deletedSignature: { userId } });
  authService.createImpersonationSession = async (admin, body) => ({
    token: 'impersonation-token',
    user: { id: body.targetUserId, role: 'user' },
    impersonation: { adminUserId: admin.id, targetUserId: body.targetUserId },
  });

  try {
    await withServer(async (baseUrl) => {
      const headers = { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' };
      const requests = [
        fetch(`${baseUrl}/api/overtime/departments/DEP-TEST`, {
          method: 'PATCH', headers, body: JSON.stringify({ departmentName: 'Updated' }),
        }),
        fetch(`${baseUrl}/api/overtime/departments/DEP-TEST`, { method: 'DELETE', headers }),
        fetch(`${baseUrl}/api/overtime/employees/EMP-TEST`, { method: 'DELETE', headers }),
        fetch(`${baseUrl}/api/users/signature/user-target`, { method: 'DELETE', headers }),
        fetch(`${baseUrl}/api/admin/impersonations`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            targetUserId: 'user-target',
            adminPassword: 'confirmed',
            remarks: 'Support investigation.',
          }),
        }),
      ];
      const responses = await Promise.all(requests);
      assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200]);
      const impersonationBody = await responses[4].json();
      assert.equal(impersonationBody.token, 'impersonation-token');
      assert.equal(impersonationBody.impersonation.adminUserId, 'user-admin');
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    overtimeService.updateDepartment = originalUpdateDepartment;
    overtimeService.deleteDepartment = originalDeleteDepartment;
    overtimeService.deleteEmployee = originalDeleteEmployee;
    signatureService.deleteUserSignature = originalDeleteSignature;
    authService.createImpersonationSession = originalImpersonate;
  }
});

test('HR cannot use Admin-only deletion or impersonation endpoints', async () => {
  const originalVerifyToken = authService.verifyToken;
  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-hr', role: 'hr', status: 'active' };
    },
  });

  try {
    await withServer(async (baseUrl) => {
      const headers = { Authorization: 'Bearer hr-token', 'Content-Type': 'application/json' };
      const responses = await Promise.all([
        fetch(`${baseUrl}/api/overtime/departments/DEP-TEST`, { method: 'DELETE', headers }),
        fetch(`${baseUrl}/api/overtime/employees/EMP-TEST`, { method: 'DELETE', headers }),
        fetch(`${baseUrl}/api/users/signature/user-target`, { method: 'DELETE', headers }),
        fetch(`${baseUrl}/api/admin/impersonations`, {
          method: 'POST', headers, body: JSON.stringify({ targetUserId: 'user-target' }),
        }),
      ]);
      assert.deepEqual(responses.map((response) => response.status), [403, 403, 403, 403]);
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
  }
});

test('employee plan signing requires a bearer token', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/overtime/plans/PLAN-TEST/sign`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ remarks: 'Confirmed for testing.' }),
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { message: 'Authentication token is required.' });
  });
});

test('an employee can resubmit a returned-for-revision plan to their supervisor', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalGetPlan = overtimeService.getOvertimePlan;
  const originalGetEmployee = overtimeService.getEmployeeByUserId;
  const originalSubmitPlan = overtimeService.submitEmployeePlanToSupervisor;

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-employee', role: 'user', status: 'active' };
    },
  });
  overtimeService.getEmployeeByUserId = async () => ({
    employeeId: 'EMPLOYEE-TEST',
    departmentId: 'DEPARTMENT-TEST',
  });
  overtimeService.getOvertimePlan = async () => ({
    planId: 'PLAN-RETURNED',
    planScope: 'employee',
    status: 'returned_for_revision',
    createdBy: 'user-employee',
    departmentId: 'DEPARTMENT-TEST',
    itemCount: 1,
    items: [{ planItemId: 'ITEM-TEST', employeeId: 'EMPLOYEE-TEST' }],
  });
  overtimeService.submitEmployeePlanToSupervisor = async (planId, userId, remarks) => {
    assert.equal(planId, 'PLAN-RETURNED');
    assert.equal(userId, 'user-employee');
    assert.equal(remarks, 'Revised dates are ready for review.');
    return {
      planId,
      status: 'submitted_to_supervisor',
      itemCount: 1,
    };
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/overtime/plans/PLAN-RETURNED/submit`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer employee-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ remarks: 'Revised dates are ready for review.' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.overtimePlan.status, 'submitted_to_supervisor');
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    overtimeService.getOvertimePlan = originalGetPlan;
    overtimeService.getEmployeeByUserId = originalGetEmployee;
    overtimeService.submitEmployeePlanToSupervisor = originalSubmitPlan;
  }
});

test('a supervisor can delete a returned overtime plan in their department', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalGetPlan = overtimeService.getOvertimePlan;
  const originalGetEmployee = overtimeService.getEmployeeByUserId;
  const originalDeletePlan = overtimeService.deleteOvertimePlan;
  let deleteCalls = 0;

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-supervisor', role: 'supervisor', status: 'active' };
    },
  });
  overtimeService.getEmployeeByUserId = async (userId) => {
    assert.equal(userId, 'user-supervisor');
    return {
      employeeId: 'SUPERVISOR-TEST',
      departmentId: 'DEPARTMENT-TEST',
    };
  };
  overtimeService.getOvertimePlan = async () => ({
    planId: 'PLAN-RETURNED',
    planScope: 'employee',
    status: 'supervisor_returned',
    createdBy: 'user-employee',
    departmentId: 'DEPARTMENT-TEST',
    itemCount: 1,
    items: [{ planItemId: 'ITEM-TEST', employeeId: 'EMPLOYEE-TEST' }],
  });
  overtimeService.deleteOvertimePlan = async (planId) => {
    deleteCalls += 1;
    assert.equal(planId, 'PLAN-RETURNED');
    return {
      planId,
      status: 'supervisor_returned',
      departmentId: 'DEPARTMENT-TEST',
    };
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/overtime/plans/PLAN-RETURNED`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer supervisor-token' },
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.message, 'Overtime plan deleted successfully.');
      assert.equal(body.overtimePlan.planId, 'PLAN-RETURNED');
      assert.equal(deleteCalls, 1);
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    overtimeService.getOvertimePlan = originalGetPlan;
    overtimeService.getEmployeeByUserId = originalGetEmployee;
    overtimeService.deleteOvertimePlan = originalDeletePlan;
  }
});

test('a supervisor can reset plan status only within their department', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalGetPlan = overtimeService.getOvertimePlan;
  const originalGetEmployee = overtimeService.getEmployeeByUserId;
  const originalResetPlanStatus = overtimeService.resetOvertimePlanStatus;
  let resetCalls = 0;

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-supervisor', role: 'supervisor', status: 'active' };
    },
  });
  overtimeService.getEmployeeByUserId = async (userId) => {
    assert.equal(userId, 'user-supervisor');
    return {
      employeeId: 'SUPERVISOR-TEST',
      departmentId: 'DEPARTMENT-TEST',
    };
  };
  overtimeService.getOvertimePlan = async (planId) => ({
    planId,
    planScope: 'employee',
    status: 'submitted_to_supervisor',
    departmentId: planId === 'PLAN-OTHER-DEPARTMENT'
      ? 'DEPARTMENT-OTHER'
      : 'DEPARTMENT-TEST',
  });
  overtimeService.resetOvertimePlanStatus = async (planId, user, resetData) => {
    resetCalls += 1;
    assert.equal(planId, 'PLAN-RESET');
    assert.equal(user.id, 'user-supervisor');
    assert.equal(resetData.newStatus, 'supervisor_returned');
    assert.equal(resetData.remarks, 'Employee needs to correct the planned dates.');
    return {
      planId,
      status: 'supervisor_returned',
      departmentId: 'DEPARTMENT-TEST',
    };
  };

  try {
    await withServer(async (baseUrl) => {
      const headers = {
        Authorization: 'Bearer supervisor-token',
        'Content-Type': 'application/json',
      };
      const response = await fetch(`${baseUrl}/api/overtime/plans/PLAN-RESET/reset-status`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          newStatus: 'supervisor_returned',
          remarks: 'Employee needs to correct the planned dates.',
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.message, 'Overtime plan status reset successfully.');
      assert.equal(body.overtimePlan.status, 'supervisor_returned');
      assert.equal(resetCalls, 1);

      const forbiddenResponse = await fetch(
        `${baseUrl}/api/overtime/plans/PLAN-OTHER-DEPARTMENT/reset-status`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            newStatus: 'supervisor_returned',
            remarks: 'Attempting a cross-department reset.',
          }),
        }
      );
      const forbiddenBody = await forbiddenResponse.json();

      assert.equal(forbiddenResponse.status, 403);
      assert.equal(forbiddenBody.message, 'You do not have permission for this department.');
      assert.equal(resetCalls, 1);
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    overtimeService.getOvertimePlan = originalGetPlan;
    overtimeService.getEmployeeByUserId = originalGetEmployee;
    overtimeService.resetOvertimePlanStatus = originalResetPlanStatus;
  }
});

test('employee draft endpoints create and replace the plan and entries atomically', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalGetPlan = overtimeService.getOvertimePlan;
  const originalGetEmployee = overtimeService.getEmployeeByUserId;
  const originalCreateDraft = overtimeService.createEmployeeOvertimePlanDraft;
  const originalReplaceDraft = overtimeService.replaceEmployeeOvertimePlanDraft;

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-employee', role: 'user', status: 'active' };
    },
  });
  overtimeService.getEmployeeByUserId = async () => ({
    employeeId: 'EMPLOYEE-TEST',
    departmentId: 'DEPARTMENT-TEST',
  });
  overtimeService.getOvertimePlan = async () => ({
    planId: 'PLAN-DRAFT',
    planScope: 'employee',
    status: 'draft',
    createdBy: 'user-employee',
    departmentId: 'DEPARTMENT-TEST',
    items: [],
  });
  overtimeService.createEmployeeOvertimePlanDraft = async (planData, items, employeeId, createdBy) => {
    assert.equal(planData.departmentId, 'DEPARTMENT-TEST');
    assert.equal(planData.periodType, 'weekly');
    assert.equal(items.length, 1);
    assert.equal(items[0].plannedDate, '2026-08-19');
    assert.equal(employeeId, 'EMPLOYEE-TEST');
    assert.equal(createdBy, 'user-employee');
    return { planId: 'PLAN-DRAFT', status: 'draft', items };
  };
  overtimeService.replaceEmployeeOvertimePlanDraft = async (planId, draftData, employeeId, updatedBy) => {
    assert.equal(planId, 'PLAN-DRAFT');
    assert.equal(draftData.expectedUpdatedAt, '2026-08-18T01:00:00.000Z');
    assert.equal(draftData.items.length, 1);
    assert.equal(employeeId, 'EMPLOYEE-TEST');
    assert.equal(updatedBy, 'user-employee');
    return { planId, status: 'draft', updatedAt: '2026-08-18T02:00:00.000Z' };
  };

  try {
    await withServer(async (baseUrl) => {
      const headers = {
        Authorization: 'Bearer employee-token',
        'Content-Type': 'application/json',
      };
      const draft = {
        periodType: 'weekly',
        periodStartDate: '2026-08-17',
        periodEndDate: '2026-08-23',
        items: [{
          plannedDate: '2026-08-19',
          plannedHours: 2,
          reason: 'Complete reports.',
        }],
      };
      const createResponse = await fetch(`${baseUrl}/api/overtime/plans/draft`, {
        method: 'POST',
        headers,
        body: JSON.stringify(draft),
      });
      const createBody = await createResponse.json();

      assert.equal(createResponse.status, 201);
      assert.equal(createBody.overtimePlan.planId, 'PLAN-DRAFT');

      const replaceResponse = await fetch(`${baseUrl}/api/overtime/plans/PLAN-DRAFT/draft`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          ...draft,
          expectedUpdatedAt: '2026-08-18T01:00:00.000Z',
        }),
      });
      const replaceBody = await replaceResponse.json();

      assert.equal(replaceResponse.status, 200);
      assert.equal(replaceBody.message, 'Employee overtime draft saved successfully.');
      assert.equal(replaceBody.overtimePlan.updatedAt, '2026-08-18T02:00:00.000Z');
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    overtimeService.getOvertimePlan = originalGetPlan;
    overtimeService.getEmployeeByUserId = originalGetEmployee;
    overtimeService.createEmployeeOvertimePlanDraft = originalCreateDraft;
    overtimeService.replaceEmployeeOvertimePlanDraft = originalReplaceDraft;
  }
});

test('an employee plan detail includes sanitized workflow progress', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalGetPlan = overtimeService.getOvertimePlan;
  const originalGetEmployee = overtimeService.getEmployeeByUserId;
  const originalGetWorkflow = overtimeService.getEmployeePlanWorkflowProgress;

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-employee', role: 'user', status: 'active' };
    },
  });
  overtimeService.getEmployeeByUserId = async () => ({
    employeeId: 'EMPLOYEE-TEST',
    departmentId: 'DEPARTMENT-TEST',
  });
  overtimeService.getOvertimePlan = async () => ({
    planId: 'PLAN-WORKFLOW',
    planScope: 'employee',
    status: 'supervisor_accepted',
    createdBy: 'user-employee',
    departmentId: 'DEPARTMENT-TEST',
    items: [],
    logs: [],
  });
  overtimeService.getEmployeePlanWorkflowProgress = async (plan) => {
    assert.equal(plan.planId, 'PLAN-WORKFLOW');
    return {
      departmentPlanStatus: 'pending_approval',
      stages: [{
        key: 'final_approval',
        label: 'Department approval',
        state: 'current',
        detail: 'Waiting for Japanese Management approval.',
        completedAt: null,
      }],
    };
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/overtime/plans/PLAN-WORKFLOW`, {
        headers: { Authorization: 'Bearer employee-token' },
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.overtimePlan.workflowProgress.departmentPlanStatus, 'pending_approval');
      assert.equal(body.overtimePlan.workflowProgress.stages[0].state, 'current');
      assert.equal(Object.hasOwn(body.overtimePlan.workflowProgress, 'currentApproverUserId'), false);
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    overtimeService.getOvertimePlan = originalGetPlan;
    overtimeService.getEmployeeByUserId = originalGetEmployee;
    overtimeService.getEmployeePlanWorkflowProgress = originalGetWorkflow;
  }
});

test('employee workflow progress reports the current approval stage without user IDs', () => {
  const progress = overtimeService.buildEmployeePlanWorkflowProgress(
    {
      status: 'supervisor_accepted',
      createdAt: '2026-08-17T01:00:00.000Z',
      supervisorReviewedAt: '2026-08-17T02:00:00.000Z',
    },
    {
      status: 'pending_approval',
      currentApproverRole: 'japanese_management',
      createdAt: '2026-08-17T03:00:00.000Z',
    }
  );

  assert.equal(progress.stages[1].state, 'completed');
  assert.equal(progress.stages[2].state, 'completed');
  assert.equal(progress.stages[3].state, 'current');
  assert.equal(progress.stages[3].detail, 'Waiting for Japanese Management approval.');
  assert.equal(JSON.stringify(progress).includes('UserId'), false);
});

test('an employee can submit and sign their plan through one endpoint', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalSubmitAndSign = overtimeService.submitAndSignEmployeeOvertimePlan;

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-employee', role: 'user', status: 'active' };
    },
  });
  overtimeService.submitAndSignEmployeeOvertimePlan = async (planId, user, body) => {
    assert.equal(planId, 'PLAN-SIGNED');
    assert.equal(user.id, 'user-employee');
    assert.equal(body.remarks, 'Confirmed and ready for supervisor review.');
    return {
      plan: { planId, status: 'submitted_to_supervisor' },
      signatureRecord: {
        signatureRecordId: 'PLANSIGNATURE-TEST',
        status: 'active',
      },
    };
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/overtime/plans/PLAN-SIGNED/submit-and-sign`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer employee-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ remarks: 'Confirmed and ready for supervisor review.' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.plan.status, 'submitted_to_supervisor');
      assert.equal(body.signatureRecord.status, 'active');
      assert.equal(body.message, 'Employee overtime plan submitted and signed successfully.');
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    overtimeService.submitAndSignEmployeeOvertimePlan = originalSubmitAndSign;
  }
});

test('an employee can withdraw their plan before supervisor review', async () => {
  const originalVerifyToken = authService.verifyToken;
  const originalWithdrawPlan = overtimeService.withdrawEmployeeOvertimePlan;

  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-employee', role: 'user', status: 'active' };
    },
  });
  overtimeService.withdrawEmployeeOvertimePlan = async (planId, user, body) => {
    assert.equal(planId, 'PLAN-SUBMITTED');
    assert.equal(user.id, 'user-employee');
    assert.equal(body.remarks, 'The planned dates need correction.');
    return {
      planId,
      status: 'draft',
      submittedBy: '',
      submittedAt: null,
    };
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/overtime/plans/PLAN-SUBMITTED/withdraw`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer employee-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ remarks: 'The planned dates need correction.' }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.message, 'Employee overtime plan withdrawn successfully.');
      assert.equal(body.plan.status, 'draft');
      assert.equal(body.plan.submittedAt, null);
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
    overtimeService.withdrawEmployeeOvertimePlan = originalWithdrawPlan;
  }
});

test('plan withdrawal requires an employee and an audit reason before database access', async () => {
  await assert.rejects(
    () => overtimeService.withdrawEmployeeOvertimePlan(
      'PLAN-SUBMITTED',
      { id: 'user-supervisor', role: 'supervisor' },
      { remarks: 'Supervisor attempt.' }
    ),
    (error) => error.code === 'PLAN_WITHDRAW_FORBIDDEN'
  );
  await assert.rejects(
    () => overtimeService.withdrawEmployeeOvertimePlan(
      'PLAN-SUBMITTED',
      { id: 'user-employee', role: 'user' },
      {}
    ),
    (error) => error.code === 'PLAN_WITHDRAW_REMARKS_REQUIRED'
  );
});

test('employee plan submission is blocked after the department period is finalized', async () => {
  const plan = {
    planId: 'PLAN-EMPLOYEE-NEW',
    departmentId: 'DEPARTMENT-TEST',
    periodType: 'weekly',
    periodStartDate: '2026-08-17',
    periodEndDate: '2026-08-23',
  };
  const executor = {
    async query(statement, values) {
      if (statement.includes('pg_advisory_xact_lock')) {
        assert.match(values[0], /DEPARTMENT-TEST:weekly:2026-08-17:2026-08-23/);
        return { rows: [] };
      }

      if (statement.includes("plan_scope, 'employee') = 'department'")) {
        return { rows: [{ plan_id: 'DEPTPLAN-FINAL', status: 'approved' }] };
      }

      throw new Error('Duplicate employee plan query must not run after a finalized-period conflict.');
    },
  };

  await assert.rejects(
    () => overtimeService.ensureEmployeePlanPeriodIsAvailable(plan, executor),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'PLAN_PERIOD_ALREADY_FINALIZED');
      return true;
    }
  );
});

test('employee plan submission is blocked by another active plan for the same employee and period', async () => {
  const plan = {
    planId: 'PLAN-EMPLOYEE-NEW',
    departmentId: 'DEPARTMENT-TEST',
    periodType: 'weekly',
    periodStartDate: '2026-08-17',
    periodEndDate: '2026-08-23',
  };
  const executor = {
    async query(statement, values) {
      if (statement.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }

      if (statement.includes("plan_scope, 'employee') = 'department'")) {
        return { rows: [] };
      }

      if (statement.includes('INNER JOIN overtime_plan_items current_item')) {
        assert.equal(values[5].includes('draft'), false);
        assert.equal(values[5].includes('submitted_to_supervisor'), true);
        return {
          rows: [{ plan_id: 'PLAN-EMPLOYEE-EXISTING', status: 'supervisor_accepted' }],
        };
      }

      throw new Error('Unexpected query in period availability test.');
    },
  };

  await assert.rejects(
    () => overtimeService.ensureEmployeePlanPeriodIsAvailable(plan, executor),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'DUPLICATE_ACTIVE_EMPLOYEE_PLAN');
      return true;
    }
  );
});

test('employee plan creation allows sibling drafts but blocks submitted workflow plans', async () => {
  const planData = {
    departmentId: 'DEPARTMENT-TEST',
    periodType: 'weekly',
    periodStartDate: '2026-08-17',
    periodEndDate: '2026-08-23',
  };
  const availableExecutor = {
    async query(statement, values) {
      if (statement.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }

      assert.equal(values[5].includes('draft'), false);
      assert.equal(values[5].includes('submitted_to_supervisor'), true);
      return { rows: [] };
    },
  };

  await overtimeService.ensureEmployeePlanCreationPeriodIsAvailable(
    planData,
    'user-employee',
    availableExecutor
  );

  const blockedExecutor = {
    async query(statement) {
      if (statement.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }

      return {
        rows: [{ plan_id: 'PLAN-SUBMITTED', status: 'submitted_to_supervisor' }],
      };
    },
  };

  await assert.rejects(
    () => overtimeService.ensureEmployeePlanCreationPeriodIsAvailable(
      planData,
      'user-employee',
      blockedExecutor
    ),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'DUPLICATE_ACTIVE_EMPLOYEE_PLAN');
      return true;
    }
  );
});

test('final document routes require a bearer token', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/overtime/plans/DEPTPLAN-TEST/final-document`);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { message: 'Authentication token is required.' });
  });
});

test('Actual OT routes require a bearer token', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/overtime/actual-periods`);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { message: 'Authentication token is required.' });
  });
});

test('untouched Actual OT is pending today and automatically actual after the day', () => {
  const pendingMetrics = getActualEntryMetrics({
    actual_date: '2026-08-21',
    planned_hours: 2,
    actual_hours: 2,
    period_status: 'open',
    last_updated_at: null,
  }, '2026-08-21');

  assert.deepEqual(pendingMetrics, {
    actualHours: 0,
    isPending: true,
    varianceHours: 0,
  });

  const automaticActualMetrics = getActualEntryMetrics({
    actual_date: '2026-08-20',
    planned_hours: 2,
    actual_hours: 0,
    period_status: 'open',
    last_updated_at: null,
  }, '2026-08-21');

  assert.deepEqual(automaticActualMetrics, {
    actualHours: 2,
    isPending: false,
    varianceHours: 0,
  });

  const confirmedMetrics = getActualEntryMetrics({
    actual_date: '2026-08-21',
    planned_hours: 2,
    actual_hours: 0,
    period_status: 'open',
    last_updated_at: '2026-08-21T12:00:00.000Z',
  }, '2026-08-21');

  assert.deepEqual(confirmedMetrics, {
    actualHours: 0,
    isPending: false,
    varianceHours: -2,
  });
});

test('legacy overtime request endpoints are removed', async () => {
  const originalVerifyToken = authService.verifyToken;
  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-test', role: 'user', status: 'active' };
    },
  });

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/overtime/requests`, {
        headers: { Authorization: 'Bearer test-user-token' },
      });
      const body = await response.json();

      assert.equal(response.status, 404);
      assert.deepEqual(body, { message: 'Route not found.' });
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
  }
});

test('employee role cannot edit Actual OT hours', async () => {
  const originalVerifyToken = authService.verifyToken;
  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-test', role: 'user', status: 'active' };
    },
  });

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/overtime/actual-entries/ACTUALENTRY-TEST`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ actualHours: 2, remarks: 'Test adjustment.' }),
      });
      const body = await response.json();

      assert.equal(response.status, 403);
      assert.deepEqual(body, { message: 'You do not have permission to access this resource.' });
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
  }
});

test('Actual OT mutation services reject unauthorized or unaudited changes before database access', async () => {
  await assert.rejects(
    updateActualEntry(
      'ACTUALENTRY-TEST',
      { actualHours: 2, remarks: 'Attempted employee edit.' },
      { id: 'user-employee', role: 'user' }
    ),
    (error) => error.code === 'ACTUAL_OVERTIME_EDIT_FORBIDDEN'
  );
  await assert.rejects(
    updateActualEntry(
      'ACTUALENTRY-TEST',
      { actualHours: 2 },
      { id: 'user-admin', role: 'admin' }
    ),
    (error) => error.code === 'ACTUAL_OVERTIME_ADJUSTMENT_REMARKS_REQUIRED'
  );
  await assert.rejects(
    updateActualEntry(
      'ACTUALENTRY-TEST',
      { remarks: 'Hours were not provided.' },
      { id: 'user-admin', role: 'admin' }
    ),
    (error) => error.code === 'ACTUAL_OVERTIME_ADJUSTMENT_REQUIRED'
  );
  await assert.rejects(
    addActualEntryComment(
      'ACTUALENTRY-TEST',
      '   ',
      { id: 'user-employee', role: 'user' }
    ),
    (error) => error.code === 'ACTUAL_OVERTIME_COMMENT_REQUIRED'
  );
  await assert.rejects(
    finalizeActualPeriod(
      'ACTUALPERIOD-TEST',
      'Attempted supervisor finalization.',
      { id: 'user-supervisor', role: 'supervisor' }
    ),
    (error) => error.code === 'ACTUAL_OVERTIME_FINALIZE_FORBIDDEN'
  );
  await assert.rejects(
    generateActualDocument(
      'ACTUALPERIOD-TEST',
      { id: 'user-supervisor', role: 'supervisor' }
    ),
    (error) => error.code === 'ACTUAL_DOCUMENT_GENERATE_FORBIDDEN'
  );
});

test('OT data purge validation requires Admin and every destructive-action confirmation', () => {
  const admin = { id: 'user-admin', role: 'admin' };
  const validInput = {
    confirmPlanId: 'DEPTPLAN-TEST',
    remarks: 'Remove an incorrect approved plan.',
    deleteSourceEmployeePlans: true,
    confirmKeepExcel: true,
  };

  assert.throws(
    () => validatePurgeRequest('DEPTPLAN-TEST', validInput, { id: 'user-hr', role: 'hr' }),
    (error) => error.code === 'OVERTIME_PURGE_ADMIN_ONLY'
  );
  assert.throws(
    () => validatePurgeRequest('DEPTPLAN-TEST', { ...validInput, confirmPlanId: 'DEPTPLAN-OTHER' }, admin),
    (error) => error.code === 'PURGE_PLAN_CONFIRMATION_MISMATCH'
  );
  assert.throws(
    () => validatePurgeRequest('DEPTPLAN-TEST', { ...validInput, remarks: ' ' }, admin),
    (error) => error.code === 'PURGE_REMARKS_REQUIRED'
  );
  assert.throws(
    () => validatePurgeRequest(
      'DEPTPLAN-TEST',
      { ...validInput, deleteSourceEmployeePlans: undefined },
      admin
    ),
    (error) => error.code === 'PURGE_SOURCE_PLAN_CONFIRMATION_REQUIRED'
  );
  assert.throws(
    () => validatePurgeRequest('DEPTPLAN-TEST', { ...validInput, confirmKeepExcel: false }, admin),
    (error) => error.code === 'PURGE_EXCEL_RETENTION_CONFIRMATION_REQUIRED'
  );
});

test('non-admin roles cannot access the OT data purge endpoint', async () => {
  const originalVerifyToken = authService.verifyToken;
  authService.verifyToken = async () => ({
    toJSON() {
      return { id: 'user-hr', role: 'hr', status: 'active' };
    },
  });

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/admin/overtime/plans/DEPTPLAN-TEST/purge-data`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-hr-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      const body = await response.json();

      assert.equal(response.status, 403);
      assert.deepEqual(body, { message: 'You do not have permission to access this resource.' });
    });
  } finally {
    authService.verifyToken = originalVerifyToken;
  }
});

test('OT data purge controller verifies the Admin password before purging', async () => {
  const originalConfirmPassword = authService.confirmAdminPassword;
  const originalPurge = overtimeService.purgeOvertimeData;
  let purgeCalled = false;
  const expectedError = new AppError('Admin password is incorrect.', 401, 'INVALID_ADMIN_PASSWORD');

  authService.confirmAdminPassword = async () => { throw expectedError; };
  overtimeService.purgeOvertimeData = async () => {
    purgeCalled = true;
  };

  try {
    let forwardedError;
    await adminController.purgeOvertimeData(
      {
        params: { departmentPlanId: 'DEPTPLAN-TEST' },
        user: { id: 'user-admin', role: 'admin' },
        body: { adminPassword: 'incorrect' },
      },
      { json() { throw new Error('A failed confirmation must not send a success response.'); } },
      (error) => { forwardedError = error; }
    );

    assert.equal(forwardedError, expectedError);
    assert.equal(purgeCalled, false);
  } finally {
    authService.confirmAdminPassword = originalConfirmPassword;
    overtimeService.purgeOvertimeData = originalPurge;
  }
});

test('OT data purge controller returns the purge audit result', async () => {
  const originalConfirmPassword = authService.confirmAdminPassword;
  const originalPurge = overtimeService.purgeOvertimeData;
  let responseBody;

  authService.confirmAdminPassword = async () => true;
  overtimeService.purgeOvertimeData = async () => ({
    purgeAuditId: 'OTPURGE-TEST',
    departmentPlanId: 'DEPTPLAN-TEST',
    excelFilesDeleted: false,
    excelFilesRetained: true,
  });

  try {
    await adminController.purgeOvertimeData(
      {
        params: { departmentPlanId: 'DEPTPLAN-TEST' },
        user: { id: 'user-admin', role: 'admin' },
        body: { adminPassword: 'valid' },
      },
      { json(body) { responseBody = body; return body; } },
      (error) => { throw error; }
    );

    assert.equal(responseBody.purgeAuditId, 'OTPURGE-TEST');
    assert.equal(responseBody.excelFilesDeleted, false);
    assert.equal(responseBody.excelFilesRetained, true);
  } finally {
    authService.confirmAdminPassword = originalConfirmPassword;
    overtimeService.purgeOvertimeData = originalPurge;
  }
});

test('final document builder creates a readable workbook with embedded signatures', async () => {
  const signatureImage = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const plan = {
    planId: 'DEPTPLAN-TEST',
    departmentId: 'DEP-TEST',
    departmentName: 'Production',
    periodStartDate: '2026-08-03',
    periodEndDate: '2026-08-09',
    plannedHours: 2.5,
    status: 'approved',
    items: [{
      employeeId: 'EMP-TEST',
      employeeNo: 'EMP-001',
      employeeName: 'Test Employee',
      plannedDate: '2026-08-05',
      plannedHours: 2.5,
      reason: 'Production support',
      sourceEmployeePlanId: 'PLAN-EMPLOYEE-TEST',
    }],
  };
  const employeeSignatures = [{
    signatureRecordId: 'PLANSIGNATURE-TEST',
    employeeId: 'EMP-TEST',
    employeeNo: 'EMP-001',
    employeeName: 'Test Employee',
    sourceEmployeePlanId: 'PLAN-EMPLOYEE-TEST',
    signatureOwnerUserId: 'user-employee',
    actedByUserId: 'user-employee',
    confirmationMethod: 'self',
    signedAt: '2026-08-03T01:00:00.000Z',
    signatureFilePath: 'users/user-employee/signature.png',
    signatureMimeType: 'image/png',
  }];
  const approvals = [{
    approvalId: 'APPROVAL-TEST',
    approverRole: 'hr',
    stepName: 'HR/Admin Final Approval',
    actedBy: 'user-hr',
    actedByName: 'Test HR',
    actedAt: '2026-08-03T02:00:00.000Z',
    status: 'approved',
    remarks: 'Approved',
    signatureFilePath: 'users/user-hr/signature.png',
    signatureMimeType: 'image/png',
  }];
  const images = new Map([
    ['users/user-employee/signature.png', signatureImage],
    ['users/user-hr/signature.png', signatureImage],
  ]);

  const buffer = await buildFinalDocumentWorkbook(plan, employeeSignatures, approvals, images);
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.getWorksheet('Official OT Plan');
  assert.equal(worksheet.getCell('A1').value, 'DEPARTMENT OVERTIME PLAN');
  assert.equal(worksheet.getImages().length, 2);
  assert.ok(workbook.getWorksheet('Signature Audit'));
});

test('Actual OT document builder includes actual values, audit history, and signatures', async () => {
  const signatureImage = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const actualPeriod = {
    actualPeriodId: 'ACTUALPERIOD-TEST',
    sourceDepartmentPlanId: 'DEPTPLAN-TEST',
    departmentName: 'Production',
    periodStartDate: '2026-08-03',
    periodEndDate: '2026-08-09',
    status: 'finalized',
    finalizedBy: 'user-hr',
    finalizedByName: 'Test HR',
    finalizedAt: '2026-08-10T01:00:00.000Z',
    finalizationRemarks: 'Weekly timekeeping complete.',
    entries: [{
      employeeNo: 'EMP-001',
      employeeName: 'Test Employee',
      actualDate: '2026-08-05',
      plannedHours: 2.5,
      actualHours: 2,
      varianceHours: -0.5,
      plannedReason: 'Production support',
      lastAdjustmentRemarks: 'Matched timekeeping record.',
      comments: [{ userName: 'Test Employee', remarks: 'Machine stopped early.' }],
      adjustments: [{
        adjustmentId: 'ACTUALADJUSTMENT-TEST',
        previousHours: 2.5,
        newHours: 2,
        changedBy: 'user-hr',
        changedByName: 'Test HR',
        remarks: 'Matched timekeeping record.',
        changedAt: '2026-08-05T12:00:00.000Z',
      }],
    }],
  };
  const employeeSignatures = [{
    confirmationMethod: 'self',
    employeeNo: 'EMP-001',
    employeeName: 'Test Employee',
    actedByUserId: 'user-employee',
    signedAt: '2026-08-03T01:00:00.000Z',
    remarks: 'Confirmed.',
    signatureFilePath: 'users/user-employee/signature.png',
    signatureMimeType: 'image/png',
  }];
  const approvals = [{
    approverRole: 'hr',
    stepName: 'HR/Admin Final Approval',
    actedBy: 'user-hr',
    actedByName: 'Test HR',
    actedAt: '2026-08-03T02:00:00.000Z',
    remarks: 'Approved.',
    signatureFilePath: 'users/user-hr/signature.png',
    signatureMimeType: 'image/png',
  }];
  const images = new Map([
    ['users/user-employee/signature.png', signatureImage],
    ['users/user-hr/signature.png', signatureImage],
  ]);

  const buffer = await buildActualOvertimeWorkbook(actualPeriod, employeeSignatures, approvals, images);
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const actualSheet = workbook.getWorksheet('Actual OT');
  const auditSheet = workbook.getWorksheet('Adjustment Audit');
  assert.equal(actualSheet.getCell('A1').value, 'FINAL ACTUAL OVERTIME RECORD');
  assert.equal(actualSheet.getRow(7).values.includes('Actual Start'), false);
  assert.equal(actualSheet.getRow(7).values.includes('Actual End'), false);
  assert.ok(auditSheet);
  assert.equal(auditSheet.getRow(1).values.includes('Previous Start'), false);
  assert.equal(auditSheet.getRow(1).values.includes('New Start'), false);
  assert.equal(auditSheet.getRow(1).values.includes('Previous End'), false);
  assert.equal(auditSheet.getRow(1).values.includes('New End'), false);
  assert.equal(workbook.getWorksheet('Approval Signatures').getImages().length, 2);
});

test('final approval leaves final document generation to the manual endpoint', async () => {
  const originalApprove = overtimeService.approveDepartmentPlanStep;
  const originalGenerate = overtimeService.generateFinalDocument;
  let generateCalls = 0;
  overtimeService.approveDepartmentPlanStep = async () => ({
    planId: 'DEPTPLAN-MANUAL-DOCUMENT-TEST',
    status: 'approved',
  });
  overtimeService.generateFinalDocument = async () => {
    generateCalls += 1;
  };

  try {
    let responseBody;
    await departmentWorkflowController.approveDepartmentPlanStep(
      {
        params: { planId: 'DEPTPLAN-MANUAL-DOCUMENT-TEST' },
        user: { id: 'user-hr', role: 'hr' },
        body: { remarks: 'Final approval.' },
      },
      { json(body) { responseBody = body; return body; } },
      (error) => { throw error; }
    );

    assert.equal(responseBody.overtimePlan.status, 'approved');
    assert.equal(Object.hasOwn(responseBody, 'finalDocument'), false);
    assert.equal(generateCalls, 0);
  } finally {
    overtimeService.approveDepartmentPlanStep = originalApprove;
    overtimeService.generateFinalDocument = originalGenerate;
  }
});
