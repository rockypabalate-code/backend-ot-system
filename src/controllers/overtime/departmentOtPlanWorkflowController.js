const overtimeService = require('../../services/overtimeDbService');

function isAdminOrHr(user) {
  return ['admin', 'hr'].includes(user.role);
}

function isSupervisorRole(user) {
  return user.role === 'supervisor';
}

function isJapaneseManagement(user) {
  return user.role === 'japanese_management';
}

async function getLinkedEmployee(user) {
  return overtimeService.getEmployeeByUserId(user.id);
}

async function requireDepartmentAccess(user, departmentId) {
  if (isAdminOrHr(user) || isJapaneseManagement(user)) {
    return { allowed: true };
  }

  const employee = await getLinkedEmployee(user);

  if (!employee) {
    return { allowed: false, reason: 'Your account is not linked to an employee profile.' };
  }

  if (isSupervisorRole(user) && employee.departmentId === departmentId) {
    return { allowed: true, employee };
  }

  return { allowed: false, reason: 'You do not have permission for this department.' };
}

async function listApprovalRoutes(req, res, next) {
  try {
    const routes = await overtimeService.getApprovalRoutes(req.query);
    return res.json({ approvalRoutes: routes });
  } catch (error) {
    return next(error);
  }
}

async function createApprovalRoute(req, res, next) {
  try {
    const route = await overtimeService.createApprovalRoute(req.body, req.user.id);
    return res.status(201).json({ approvalRoute: route });
  } catch (error) {
    return next(error);
  }
}

async function getApprovalRoute(req, res, next) {
  try {
    const route = await overtimeService.getApprovalRoute(req.params.routeId);

    if (!route) {
      return res.status(404).json({ message: 'Approval route not found.' });
    }

    return res.json({ approvalRoute: route });
  } catch (error) {
    return next(error);
  }
}

async function addApprovalRouteAssignment(req, res, next) {
  try {
    const assignment = await overtimeService.addApprovalRouteAssignment(req.params.routeId, req.body);
    return res.status(201).json({ approvalRouteAssignment: assignment });
  } catch (error) {
    return next(error);
  }
}

async function deleteApprovalRouteAssignment(req, res, next) {
  try {
    const result = await overtimeService.deleteApprovalRouteAssignment(req.params.routeId, req.params.assignmentId);
    return res.json({ message: 'Approval route assignment deleted successfully.', ...result });
  } catch (error) {
    return next(error);
  }
}

// Backward-compatible controller names only. Use /assignments routes going forward.
async function addApprovalRouteStep(req, res, next) {
  return addApprovalRouteAssignment(req, res, next);
}

async function deleteApprovalRouteStep(req, res, next) {
  req.params.assignmentId = req.params.stepId;
  return deleteApprovalRouteAssignment(req, res, next);
}

async function setApprovalRouteStatus(req, res, next) {
  try {
    const route = await overtimeService.setApprovalRouteStatus(req.params.routeId, req.body.status);
    return res.json({ approvalRoute: route });
  } catch (error) {
    return next(error);
  }
}

async function getSupervisorPlanDashboard(req, res, next) {
  try {
    let departmentId = req.query.departmentId;

    if (isSupervisorRole(req.user)) {
      const employee = await getLinkedEmployee(req.user);
      departmentId = employee ? employee.departmentId : '';
    }

    const access = await requireDepartmentAccess(req.user, departmentId);

    if (!access.allowed) {
      return res.status(403).json({ message: access.reason });
    }

    const dashboard = await overtimeService.getSupervisorPlanDashboard({
      ...req.query,
      departmentId,
      supervisorUserId: isSupervisorRole(req.user) && !isAdminOrHr(req.user) ? req.user.id : req.query.supervisorUserId,
      includeUnassigned: isSupervisorRole(req.user) && !isAdminOrHr(req.user)
        ? false
        : req.query.includeUnassigned,
    });

    return res.json({ supervisorDashboard: dashboard });
  } catch (error) {
    return next(error);
  }
}

async function createDepartmentPlanFromEmployeeDrafts(req, res, next) {
  try {
    let departmentId = req.body.departmentId;

    if (isSupervisorRole(req.user)) {
      const employee = await getLinkedEmployee(req.user);
      departmentId = employee ? employee.departmentId : '';
    }

    const access = await requireDepartmentAccess(req.user, departmentId);

    if (!access.allowed || (!isSupervisorRole(req.user) && !isAdminOrHr(req.user))) {
      return res.status(403).json({ message: access.reason || 'Only supervisor, admin, or HR can create department OT plans from employee drafts.' });
    }

    const overtimePlan = await overtimeService.createDepartmentPlanFromEmployeeDrafts(
      {
        ...req.body,
        departmentId,
        supervisorUserId: isSupervisorRole(req.user) && !isAdminOrHr(req.user)
          ? req.user.id
          : req.body.supervisorUserId,
      },
      req.user.id
    );

    return res.status(201).json({ overtimePlan });
  } catch (error) {
    return next(error);
  }
}

async function createSupervisorDepartmentPlanDraft(req, res, next) {
  try {
    const employee = await getLinkedEmployee(req.user);

    if (!employee) {
      return res.status(403).json({ message: 'Your account is not linked to an employee profile.' });
    }

    const overtimePlan = await overtimeService.createSupervisorDepartmentPlanDraft(
      {
        ...req.body,
        departmentId: employee.departmentId,
        supervisorUserId: req.user.id,
      },
      req.user.id
    );

    return res.status(201).json({
      message: 'Bulk department overtime draft created successfully.',
      overtimePlan,
    });
  } catch (error) {
    return next(error);
  }
}

async function replaceSupervisorDepartmentPlanDraft(req, res, next) {
  try {
    const [employee, plan] = await Promise.all([
      getLinkedEmployee(req.user),
      overtimeService.getOvertimePlan(req.params.planId),
    ]);

    if (!employee) {
      return res.status(403).json({ message: 'Your account is not linked to an employee profile.' });
    }

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    if ((plan.planScope || 'employee') !== 'department' || plan.departmentId !== employee.departmentId) {
      return res.status(403).json({
        message: 'You can only edit department overtime drafts for your own department.',
      });
    }

    const overtimePlan = await overtimeService.replaceSupervisorDepartmentPlanDraft(
      req.params.planId,
      req.body,
      req.user.id
    );

    return res.json({
      message: 'Bulk department overtime draft saved successfully.',
      overtimePlan,
    });
  } catch (error) {
    return next(error);
  }
}

async function supervisorAcceptEmployeePlan(req, res, next) {
  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const access = await requireDepartmentAccess(req.user, plan.departmentId);

    if (!access.allowed || !isSupervisorRole(req.user)) {
      return res.status(403).json({ message: access.reason || 'Only the department supervisor can accept employee OT plans.' });
    }

    const overtimePlan = await overtimeService.supervisorReviewEmployeePlan(
      req.params.planId,
      'accept',
      req.user.id,
      req.body.remarks
    );

    return res.json({ overtimePlan });
  } catch (error) {
    return next(error);
  }
}

async function supervisorReturnEmployeePlan(req, res, next) {
  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const access = await requireDepartmentAccess(req.user, plan.departmentId);

    if (!access.allowed || !isSupervisorRole(req.user)) {
      return res.status(403).json({ message: access.reason || 'Only the department supervisor can return employee OT plans.' });
    }

    const overtimePlan = await overtimeService.supervisorReviewEmployeePlan(
      req.params.planId,
      'return',
      req.user.id,
      req.body.remarks
    );

    return res.json({ overtimePlan });
  } catch (error) {
    return next(error);
  }
}

async function startDepartmentPlanApproval(req, res, next) {
  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    const access = await requireDepartmentAccess(req.user, plan.departmentId);

    if (!access.allowed || (!isSupervisorRole(req.user) && !isAdminOrHr(req.user))) {
      return res.status(403).json({ message: access.reason || 'Only supervisor, admin, or HR can submit department OT plans for approval.' });
    }

    const overtimePlan = await overtimeService.startDepartmentPlanApproval(req.params.planId, req.user, req.body.remarks);
    return res.json({ overtimePlan });
  } catch (error) {
    return next(error);
  }
}

async function approveDepartmentPlanStep(req, res, next) {
  try {
    const overtimePlan = await overtimeService.approveDepartmentPlanStep(
      req.params.planId,
      req.user,
      req.body && req.body.remarks
    );
    return res.json({ overtimePlan });
  } catch (error) {
    return next(error);
  }
}

async function rejectDepartmentPlanStep(req, res, next) {
  try {
    const overtimePlan = await overtimeService.rejectDepartmentPlanStep(req.params.planId, req.user, req.body.remarks);
    return res.json({ overtimePlan });
  } catch (error) {
    return next(error);
  }
}


async function resetOvertimePlanStatus(req, res, next) {
  try {
    if (isSupervisorRole(req.user)) {
      const plan = await overtimeService.getOvertimePlan(req.params.planId);

      if (!plan) {
        return res.status(404).json({ message: 'Overtime plan not found.' });
      }

      const access = await requireDepartmentAccess(req.user, plan.departmentId);

      if (!access.allowed) {
        return res.status(403).json({ message: access.reason });
      }
    }

    const overtimePlan = await overtimeService.resetOvertimePlanStatus(
      req.params.planId,
      req.user,
      req.body
    );

    return res.json({
      message: 'Overtime plan status reset successfully.',
      overtimePlan,
    });
  } catch (error) {
    return next(error);
  }
}

async function listMyPendingDepartmentPlanApprovals(req, res, next) {
  try {
    const pendingApprovals = await overtimeService.getPendingDepartmentPlanApprovalsForUser(req.user, req.query);
    return res.json({ pendingApprovals });
  } catch (error) {
    return next(error);
  }
}

async function getDepartmentPlanApprovalDetails(req, res, next) {
  try {
    const overtimePlan = await overtimeService.getDepartmentPlanApprovalDetails(req.params.planId);

    if (!overtimePlan) {
      return res.status(404).json({ message: 'Overtime plan not found.' });
    }

    if (isJapaneseManagement(req.user)) {
      return res.json({ overtimePlan });
    }

    const access = await requireDepartmentAccess(req.user, overtimePlan.departmentId);

    if (!access.allowed) {
      return res.status(403).json({ message: access.reason || 'You do not have permission to access this approval workflow.' });
    }

    return res.json({ overtimePlan });
  } catch (error) {
    return next(error);
  }
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
  getApprovalRoute,
  getDepartmentPlanApprovalDetails,
  getSupervisorPlanDashboard,
  listApprovalRoutes,
  listMyPendingDepartmentPlanApprovals,
  rejectDepartmentPlanStep,
  replaceSupervisorDepartmentPlanDraft,
  resetOvertimePlanStatus,
  setApprovalRouteStatus,
  startDepartmentPlanApproval,
  supervisorAcceptEmployeePlan,
  supervisorReturnEmployeePlan,
};
