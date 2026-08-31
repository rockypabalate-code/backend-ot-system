const departmentController = require('./departmentController');
const employeeController = require('./employeeController');
const overtimePlanController = require('./overtimePlanController');
const departmentOtPlanWorkflowController = require('./departmentOtPlanWorkflowController');
const policyController = require('./policyController');
const employeePlanSignatureController = require('./employeePlanSignatureController');
const finalDocumentController = require('./finalDocumentController');
const actualOvertimeController = require('./actualOvertimeController');

module.exports = {
  ...departmentController,
  ...employeeController,
  ...overtimePlanController,
  ...departmentOtPlanWorkflowController,
  ...policyController,
  ...employeePlanSignatureController,
  ...finalDocumentController,
  ...actualOvertimeController,
};
