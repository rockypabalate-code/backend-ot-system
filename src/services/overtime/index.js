const departmentService = require('./departmentService');
const employeeService = require('./employeeService');
const overtimePlanService = require('./overtimePlanService');
const departmentOtPlanWorkflowService = require('./departmentOtPlanWorkflowService');
const policyService = require('./policyService');
const employeePlanSignatureService = require('./employeePlanSignatureService');
const finalDocumentService = require('./finalDocumentService');
const actualOvertimeService = require('./actualOvertimeService');
const actualOvertimeDocumentService = require('./actualOvertimeDocumentService');
const overtimePurgeService = require('./overtimePurgeService');

module.exports = {
  ...departmentService,
  ...employeeService,
  ...overtimePlanService,
  ...departmentOtPlanWorkflowService,
  ...policyService,
  ...employeePlanSignatureService,
  ...finalDocumentService,
  ...actualOvertimeService,
  ...actualOvertimeDocumentService,
  ...overtimePurgeService,
};
