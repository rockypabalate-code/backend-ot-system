const express = require('express');
const overtimeController = require('../controllers/overtimeController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate);

// View-only master data access is allowed for Japanese Management.
router.get('/departments', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.listDepartments);
router.post('/departments', authorize('admin', 'hr'), overtimeController.createDepartment);
router.patch('/departments/:departmentId', authorize('admin', 'hr'), overtimeController.updateDepartment);
router.delete('/departments/:departmentId', authorize('admin'), overtimeController.deleteDepartment);

router.get('/employees', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.listEmployees);
router.get('/employees/me', authorize('user', 'supervisor'), overtimeController.getMyEmployee);
router.get('/employees/:employeeId', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.getEmployee);
router.post('/employees', authorize('admin', 'hr'), overtimeController.createEmployee);
router.patch('/employees/:employeeId', authorize('admin', 'hr'), overtimeController.updateEmployee);
router.delete('/employees/:employeeId', authorize('admin'), overtimeController.deleteEmployee);

router.get('/policies', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.listPolicies);

router.get('/actual-periods', authorize('admin', 'hr', 'supervisor', 'japanese_management', 'user'), overtimeController.listActualOvertimePeriods);
router.get('/actual-periods/:actualPeriodId', authorize('admin', 'hr', 'supervisor', 'japanese_management', 'user'), overtimeController.getActualOvertimePeriod);
router.patch('/actual-periods/:actualPeriodId/finalize', authorize('admin', 'hr'), overtimeController.finalizeActualOvertimePeriod);
router.post('/actual-periods/:actualPeriodId/final-document/generate', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.generateActualOvertimeDocument);
router.get('/actual-periods/:actualPeriodId/final-document', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.getActualOvertimeDocument);
router.patch('/actual-entries/:actualEntryId', authorize('admin', 'hr', 'supervisor'), overtimeController.updateActualOvertimeEntry);
router.post('/actual-entries/:actualEntryId/comments', authorize('admin', 'hr', 'supervisor', 'user'), overtimeController.addActualOvertimeComment);

router.get('/approval-routes', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.listApprovalRoutes);
router.post('/approval-routes', authorize('admin', 'hr'), overtimeController.createApprovalRoute);
router.get('/approval-routes/:routeId', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.getApprovalRoute);
router.post('/approval-routes/:routeId/assignments', authorize('admin', 'hr'), overtimeController.addApprovalRouteAssignment);
router.delete('/approval-routes/:routeId/assignments/:assignmentId', authorize('admin', 'hr'), overtimeController.deleteApprovalRouteAssignment);
router.patch('/approval-routes/:routeId/status', authorize('admin', 'hr'), overtimeController.setApprovalRouteStatus);

router.get('/plans', overtimeController.listOvertimePlans);
router.get('/plans/items', overtimeController.listOvertimePlanItems);
router.get('/plans/calendar', overtimeController.getOvertimePlanCalendarSummary);
router.get('/plans/pending-approvals', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.listMyPendingDepartmentPlanApprovals);
router.get('/plans/supervisor-dashboard', authorize('admin', 'hr', 'supervisor'), overtimeController.getSupervisorPlanDashboard);
router.post('/plans/department/from-drafts', authorize('admin', 'hr', 'supervisor'), overtimeController.createDepartmentPlanFromEmployeeDrafts);
router.post('/plans/department/bulk-draft', authorize('supervisor'), overtimeController.createSupervisorDepartmentPlanDraft);
router.post('/plans/draft', authorize('user'), overtimeController.createEmployeeOvertimePlanDraft);
router.post('/plans', authorize('admin', 'hr', 'supervisor', 'user'), overtimeController.createOvertimePlan);
router.patch('/plans/:planId/submit-and-sign', authorize('user'), overtimeController.submitAndSignEmployeeOvertimePlan);
router.patch('/plans/:planId/withdraw', authorize('user'), overtimeController.withdrawEmployeeOvertimePlan);
router.patch('/plans/:planId/submit', authorize('admin', 'hr', 'supervisor', 'user'), overtimeController.submitOvertimePlan);
router.patch('/plans/:planId/sign', authorize('supervisor', 'user'), overtimeController.signEmployeeOvertimePlan);
router.patch('/plans/:planId/approve', authorize('admin', 'hr'), overtimeController.approveOvertimePlan);
router.patch('/plans/:planId/reject', authorize('admin', 'hr'), overtimeController.rejectOvertimePlan);
router.patch('/plans/:planId/close', authorize('admin', 'hr', 'supervisor'), overtimeController.closeOvertimePlan);
router.patch('/plans/:planId/supervisor-accept', authorize('supervisor'), overtimeController.supervisorAcceptEmployeePlan);
router.patch('/plans/:planId/supervisor-return', authorize('supervisor'), overtimeController.supervisorReturnEmployeePlan);
router.patch('/plans/:planId/department-submit-and-sign', authorize('supervisor'), overtimeController.startDepartmentPlanApproval);
router.patch('/plans/:planId/start-approval', authorize('admin', 'hr', 'supervisor'), overtimeController.startDepartmentPlanApproval);
router.patch('/plans/:planId/reset-status', authorize('admin', 'hr', 'supervisor'), overtimeController.resetOvertimePlanStatus);
router.get('/plans/:planId/approval-details', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.getDepartmentPlanApprovalDetails);
router.patch('/plans/:planId/approval/approve', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.approveDepartmentPlanStep);
router.patch('/plans/:planId/approval/reject', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.rejectDepartmentPlanStep);
router.post('/plans/:planId/final-document/generate', authorize('admin', 'hr'), overtimeController.generateFinalDocument);
router.get('/plans/:planId/final-document', authorize('admin', 'hr', 'supervisor', 'japanese_management'), overtimeController.getFinalDocument);
router.post('/plans/:planId/items', authorize('admin', 'hr', 'supervisor', 'user'), overtimeController.addOvertimePlanItem);
router.post('/plans/:planId/items/bulk', authorize('admin', 'hr', 'supervisor', 'user'), overtimeController.addOvertimePlanItems);
router.put('/plans/:planId/department/bulk-draft', authorize('supervisor'), overtimeController.replaceSupervisorDepartmentPlanDraft);
router.put('/plans/:planId/draft', authorize('user'), overtimeController.replaceEmployeeOvertimePlanDraft);
router.patch('/plans/:planId/items/:itemId', authorize('admin', 'hr', 'supervisor', 'user'), overtimeController.updateOvertimePlanItem);
router.delete('/plans/:planId/items/:itemId', authorize('admin', 'hr', 'supervisor', 'user'), overtimeController.deleteOvertimePlanItem);
router.get('/plans/:planId', overtimeController.getOvertimePlan);
router.patch('/plans/:planId', authorize('admin', 'hr', 'supervisor', 'user'), overtimeController.updateOvertimePlan);
router.delete('/plans/:planId', authorize('admin', 'hr', 'supervisor', 'user'), overtimeController.deleteOvertimePlan);

module.exports = router;
