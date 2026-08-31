const overtimeService = require('../../services/overtimeDbService');

function isAdminOrHr(user) {
  return ['admin', 'hr'].includes(user.role);
}

function isSupervisor(user) {
  return user.role === 'supervisor';
}

function isJapaneseManagement(user) {
  return user.role === 'japanese_management';
}

function isUser(user) {
  return user.role === 'user';
}

async function getLinkedEmployee(user) {
  return overtimeService.getEmployeeByUserId(user.id);
}

async function buildPlanListFilters(user, query) {
  if (isAdminOrHr(user)) {
    return { filters: { ...query } };
  }

  if (isJapaneseManagement(user)) {
    return { filters: { ...query } };
  }

  const employee = await getLinkedEmployee(user);

  if (!employee) {
    return { forbidden: true };
  }

  if (isSupervisor(user)) {
    return {
      filters: {
        ...query,
        departmentId: employee.departmentId,
      },
    };
  }

  return {
    filters: {
      ...query,
      collapseFinalizedSources: true,
      userId: user.id,
      userAccessibleEmployeeId: employee.employeeId,
    },
    userEmployeeId: employee.employeeId,
  };
}

async function buildPlanItemListFilters(user, query) {
  if (isAdminOrHr(user)) {
    return { filters: { ...query } };
  }

  const employee = await getLinkedEmployee(user);

  if (isJapaneseManagement(user)) {
    return { filters: { ...query } };
  }

  if (!employee) {
    return { forbidden: true };
  }

  if (isSupervisor(user)) {
    return {
      filters: {
        ...query,
        departmentId: employee.departmentId,
      },
    };
  }

  return {
    filters: {
      ...query,
      collapseFinalizedSources: true,
      employeeId: employee.employeeId,
    },
  };
}

async function canAccessPlan(user, plan) {
  if (isAdminOrHr(user)) {
    return { allowed: true };
  }

  if (isJapaneseManagement(user)) {
    return { allowed: true };
  }

  const employee = await getLinkedEmployee(user);

  if (!employee) {
    return { allowed: false };
  }

  if (isSupervisor(user)) {
    return {
      allowed: plan.departmentId === employee.departmentId,
    };
  }

  if (isUser(user)) {
    const isOwnCreatedPlan = plan.createdBy === user.id;
    const isFinalIncludedPlan = ['approved', 'closed'].includes(plan.status)
      && plan.items.some((item) => item.employeeId === employee.employeeId);

    return {
      allowed: isOwnCreatedPlan || isFinalIncludedPlan,
      userEmployeeId: employee.employeeId,
      showOnlyOwnItems: !isOwnCreatedPlan,
    };
  }

  return { allowed: false };
}

async function canManagePlan(user, plan) {
  if (isAdminOrHr(user)) {
    return true;
  }

  const employee = await getLinkedEmployee(user);

  if (!employee) {
    return false;
  }

  if (isSupervisor(user)) {
    return plan.departmentId === employee.departmentId;
  }

  if (isUser(user)) {
    return plan.createdBy === user.id;
  }

  return false;
}

async function resolvePlanDepartmentForCreation(user, body) {
  if (isAdminOrHr(user)) {
    return body.departmentId;
  }

  const employee = await getLinkedEmployee(user);

  if (!employee) {
    return null;
  }

  if (body.departmentId && body.departmentId !== employee.departmentId) {
    return null;
  }

  if (isSupervisor(user) || isUser(user)) {
    return employee.departmentId;
  }

  return null;
}

async function preparePlanItemBodyForRole(user, body, options = {}) {
  if (!isUser(user)) {
    return { ...body };
  }

  const employee = await getLinkedEmployee(user);

  if (!employee) {
    return null;
  }

  if (body.employeeId && body.employeeId !== employee.employeeId) {
    return { forbidden: true };
  }

  const prepared = {
    ...body,
    employeeId: employee.employeeId,
  };

  if (options.update && Object.prototype.hasOwnProperty.call(body, 'employeeId')) {
    delete prepared.employeeId;
  }

  return prepared;
}

async function prepareBulkPlanItemsForRole(user, body) {
  if (!isUser(user)) {
    return { ...body };
  }

  const employee = await getLinkedEmployee(user);

  if (!employee) {
    return null;
  }

  const items = Array.isArray(body.items) ? body.items : [];
  const hasOtherEmployee = items.some((item) => item.employeeId && item.employeeId !== employee.employeeId);

  if (hasOtherEmployee) {
    return { forbidden: true };
  }

  return {
    ...body,
    items: items.map((item) => ({
      ...item,
      employeeId: employee.employeeId,
    })),
  };
}

async function listOvertimePlanItems(req, res, next) {
  try {
    const scope = await buildPlanItemListFilters(req.user, req.query);

    if (scope.forbidden) {
      return res.status(403).json({ message: 'Your account is not linked to an employee profile.' });
    }

    const items = await overtimeService.getOvertimePlanItems(scope.filters);
    return res.json({ overtimePlanItems: items });
  } catch (error) {
    return next(error);
  }
}

async function getOvertimePlanCalendarSummary(req, res, next) {
  try {
    const scope = await buildPlanItemListFilters(req.user, req.query);

    if (scope.forbidden) {
      return res.status(403).json({ message: 'Your account is not linked to an employee profile.' });
    }

    const calendar = await overtimeService.getOvertimePlanCalendarSummary(scope.filters);
    return res.json({ calendar });
  } catch (error) {
    return next(error);
  }
}

async function listOvertimePlans(req, res, next) {
  try {
    const scope = await buildPlanListFilters(req.user, req.query);

    if (scope.forbidden) {
      return res.status(403).json({ message: 'Your account is not linked to an employee profile.' });
    }

    const plans = await overtimeService.getOvertimePlans(scope.filters);
    return res.json({ overtimePlans: plans });
  } catch (error) {
    return next(error);
  }
}

async function createOvertimePlan(req, res, next) {
  const { periodType, periodStartDate, periodEndDate } = req.body;

  if (!periodType || !periodStartDate || !periodEndDate) {
    return res.status(400).json({
      message: 'Period type, period start date, and period end date are required.',
    });
  }

  try {
    const departmentId = await resolvePlanDepartmentForCreation(req.user, req.body);

    if (!departmentId) {
      return res.status(403).json({ message: 'You do not have permission to create an overtime plan for this department.' });
    }

    const planScope = req.body.planScope || (isUser(req.user) ? 'employee' : 'department');

    const plan = await overtimeService.createOvertimePlan(
      {
        ...req.body,
        departmentId,
        planScope,
      },
      req.user.id
    );

    return res.status(201).json({ overtimePlan: plan });
  } catch (error) {
    return next(error);
  }
}

async function createEmployeeOvertimePlanDraft(req, res, next) {
  if (!Array.isArray(req.body.items) || req.body.items.length === 0) {
    return res.status(400).json({ message: 'items must be a non-empty array.' });
  }

  try {
    const employee = await getLinkedEmployee(req.user);

    if (!employee) {
      return res.status(403).json({ message: 'Your account is not linked to an employee profile.' });
    }

    const overtimePlan = await overtimeService.createEmployeeOvertimePlanDraft(
      {
        departmentId: employee.departmentId,
        periodType: req.body.periodType,
        periodStartDate: req.body.periodStartDate,
        periodEndDate: req.body.periodEndDate,
        remarks: req.body.remarks,
      },
      req.body.items,
      employee.employeeId,
      req.user.id
    );

    return res.status(201).json({ overtimePlan });
  } catch (error) {
    return next(error);
  }
}

async function getOvertimePlan(req, res, next) {
  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const access = await canAccessPlan(req.user, plan);

    if (!access.allowed) {
      return res.status(403).json({ message: 'You do not have permission to access this overtime plan.' });
    }

    if (access.showOnlyOwnItems && access.userEmployeeId) {
      const userPlan = await overtimeService.getOvertimePlan(req.params.planId, {
        userEmployeeId: access.userEmployeeId,
      });
      return res.json({ overtimePlan: userPlan });
    }

    if (isUser(req.user) && (plan.planScope || 'employee') === 'employee' && plan.createdBy === req.user.id) {
      const workflowProgress = await overtimeService.getEmployeePlanWorkflowProgress(plan);
      return res.json({ overtimePlan: { ...plan, workflowProgress } });
    }

    return res.json({ overtimePlan: plan });
  } catch (error) {
    return next(error);
  }
}

async function updateOvertimePlan(req, res, next) {
  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const allowed = await canManagePlan(req.user, plan);

    if (!allowed) {
      return res.status(403).json({ message: 'You do not have permission to update this overtime plan.' });
    }

    const updates = { ...req.body, updatedBy: req.user.id };

    if ((isSupervisor(req.user) || isUser(req.user)) && updates.departmentId && updates.departmentId !== plan.departmentId) {
      return res.status(403).json({ message: 'You cannot move an overtime plan to another department.' });
    }

    if (isUser(req.user)) {
      delete updates.departmentId;
    }

    const updatedPlan = await overtimeService.updateOvertimePlan(req.params.planId, updates);
    return res.json({ overtimePlan: updatedPlan });
  } catch (error) {
    return next(error);
  }
}

async function replaceEmployeeOvertimePlanDraft(req, res, next) {
  if (!Array.isArray(req.body.items) || req.body.items.length === 0) {
    return res.status(400).json({ message: 'items must be a non-empty array.' });
  }

  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    if ((plan.planScope || 'employee') !== 'employee' || plan.createdBy !== req.user.id) {
      return res.status(403).json({ message: 'You can only replace your own employee overtime draft.' });
    }

    const employee = await getLinkedEmployee(req.user);

    if (!employee) {
      return res.status(403).json({ message: 'Your account is not linked to an employee profile.' });
    }

    const overtimePlan = await overtimeService.replaceEmployeeOvertimePlanDraft(
      req.params.planId,
      req.body,
      employee.employeeId,
      req.user.id
    );

    return res.json({
      message: 'Employee overtime draft saved successfully.',
      overtimePlan,
    });
  } catch (error) {
    return next(error);
  }
}

async function deleteOvertimePlan(req, res, next) {
  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const allowed = await canManagePlan(req.user, plan);

    if (!allowed) {
      return res.status(403).json({ message: 'You do not have permission to delete this overtime plan.' });
    }

    const deletedPlan = await overtimeService.deleteOvertimePlan(req.params.planId);
    return res.json({
      message: 'Overtime plan deleted successfully.',
      overtimePlan: deletedPlan,
    });
  } catch (error) {
    return next(error);
  }
}

async function changeOvertimePlanStatus(req, res, next, nextStatus) {
  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const allowed = await canManagePlan(req.user, plan);

    if (!allowed) {
      return res.status(403).json({ message: 'You do not have permission to update this overtime plan status.' });
    }

    if ((plan.planScope || 'employee') === 'department' && ['approved', 'rejected'].includes(nextStatus)) {
      return res.status(400).json({
        message: 'Department OT plans must be approved or returned through the configured approval route.',
        code: 'DEPARTMENT_PLAN_REQUIRES_APPROVAL_ROUTE',
      });
    }

    if (['approved', 'rejected'].includes(nextStatus) && !isAdminOrHr(req.user)) {
      return res.status(403).json({ message: 'Only admin or HR can approve or reject overtime plans.' });
    }

    const updatedPlan = await overtimeService.changeOvertimePlanStatus(
      req.params.planId,
      nextStatus,
      req.user.id,
      req.body.remarks
    );

    return res.json({ overtimePlan: updatedPlan });
  } catch (error) {
    return next(error);
  }
}

async function submitOvertimePlan(req, res, next) {
  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const allowed = await canManagePlan(req.user, plan);

    if (!allowed) {
      return res.status(403).json({ message: 'You do not have permission to submit this overtime plan.' });
    }

    if ((plan.planScope || 'employee') === 'department') {
      const overtimePlan = await overtimeService.startDepartmentPlanApproval(req.params.planId, req.user, req.body.remarks);
      return res.json({ overtimePlan });
    }

    const overtimePlan = await overtimeService.submitEmployeePlanToSupervisor(
      req.params.planId,
      req.user.id,
      req.body.remarks
    );

    return res.json({ overtimePlan });
  } catch (error) {
    return next(error);
  }
}

function approveOvertimePlan(req, res, next) {
  return changeOvertimePlanStatus(req, res, next, 'approved');
}

function rejectOvertimePlan(req, res, next) {
  return changeOvertimePlanStatus(req, res, next, 'rejected');
}

function closeOvertimePlan(req, res, next) {
  return changeOvertimePlanStatus(req, res, next, 'closed');
}

async function addOvertimePlanItem(req, res, next) {
  const plannedDate = req.body.plannedDate ?? req.body.date;
  const plannedHours = req.body.plannedHours ?? req.body.totalHours;

  if (!plannedDate || plannedHours === undefined || !req.body.reason) {
    return res.status(400).json({
      message: 'Planned date, planned hours, and reason are required.',
    });
  }

  if (!isUser(req.user) && !req.body.employeeId) {
    return res.status(400).json({ message: 'Employee ID is required.' });
  }

  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const allowed = await canManagePlan(req.user, plan);

    if (!allowed) {
      return res.status(403).json({ message: 'You do not have permission to add items to this overtime plan.' });
    }

    const itemBody = await preparePlanItemBodyForRole(req.user, req.body);

    if (!itemBody) {
      return res.status(403).json({ message: 'Your account is not linked to an employee profile.' });
    }

    if (itemBody.forbidden) {
      return res.status(403).json({ message: 'Users can add planned overtime only for their own employee profile.' });
    }

    const result = await overtimeService.addOvertimePlanItem(req.params.planId, itemBody, req.user.id);
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
}

async function addOvertimePlanItems(req, res, next) {
  if (!Array.isArray(req.body.items) || req.body.items.length === 0) {
    return res.status(400).json({ message: 'items must be a non-empty array.' });
  }

  if (req.body.items.length > 100) {
    return res.status(400).json({ message: 'A maximum of 100 plan items can be added at a time.' });
  }

  if (!isUser(req.user)) {
    const missingEmployee = req.body.items.some((item) => !item.employeeId);

    if (missingEmployee) {
      return res.status(400).json({ message: 'Employee ID is required for every plan item.' });
    }
  }

  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const allowed = await canManagePlan(req.user, plan);

    if (!allowed) {
      return res.status(403).json({ message: 'You do not have permission to add items to this overtime plan.' });
    }

    const itemBody = await prepareBulkPlanItemsForRole(req.user, req.body);

    if (!itemBody) {
      return res.status(403).json({ message: 'Your account is not linked to an employee profile.' });
    }

    if (itemBody.forbidden) {
      return res.status(403).json({ message: 'Users can add planned overtime only for their own employee profile.' });
    }

    const result = await overtimeService.addOvertimePlanItems(req.params.planId, itemBody.items, req.user.id);
    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
}

async function updateOvertimePlanItem(req, res, next) {
  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const allowed = await canManagePlan(req.user, plan);

    if (!allowed) {
      return res.status(403).json({ message: 'You do not have permission to update this overtime plan item.' });
    }

    const itemBody = await preparePlanItemBodyForRole(req.user, req.body, { update: true });

    if (!itemBody) {
      return res.status(403).json({ message: 'Your account is not linked to an employee profile.' });
    }

    if (itemBody.forbidden) {
      return res.status(403).json({ message: 'Users cannot move a plan item to another employee.' });
    }

    const result = await overtimeService.updateOvertimePlanItem(
      req.params.planId,
      req.params.itemId,
      itemBody,
      req.user.id
    );

    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function deleteOvertimePlanItem(req, res, next) {
  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const allowed = await canManagePlan(req.user, plan);

    if (!allowed) {
      return res.status(403).json({ message: 'You do not have permission to delete this overtime plan item.' });
    }

    const result = await overtimeService.deleteOvertimePlanItem(req.params.planId, req.params.itemId, req.user.id);
    return res.json({
      message: 'Overtime plan item deleted successfully.',
      ...result,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  addOvertimePlanItem,
  addOvertimePlanItems,
  approveOvertimePlan,
  closeOvertimePlan,
  createEmployeeOvertimePlanDraft,
  createOvertimePlan,
  deleteOvertimePlan,
  deleteOvertimePlanItem,
  getOvertimePlan,
  getOvertimePlanCalendarSummary,
  listOvertimePlanItems,
  listOvertimePlans,
  rejectOvertimePlan,
  replaceEmployeeOvertimePlanDraft,
  submitOvertimePlan,
  updateOvertimePlan,
  updateOvertimePlanItem,
};
