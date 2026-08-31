const overtimeService = require('../../services/overtimeDbService');

async function requireDocumentAccess(user, plan) {
  if (['admin', 'hr', 'japanese_management'].includes(user.role)) {
    return true;
  }

  if (user.role !== 'supervisor') {
    return false;
  }

  const employee = await overtimeService.getEmployeeByUserId(user.id);
  return Boolean(employee && employee.departmentId === plan.departmentId);
}

async function generateFinalDocument(req, res, next) {
  try {
    const finalDocument = await overtimeService.generateFinalDocument(
      req.params.planId,
      req.user.id,
      { force: req.body && req.body.force === true }
    );
    const downloadableDocument = await overtimeService.createFinalDocumentSignedUrl(finalDocument);

    return res.json({
      message: 'Final Excel document generated successfully.',
      finalDocument: downloadableDocument,
    });
  } catch (error) {
    return next(error);
  }
}

async function getFinalDocument(req, res, next) {
  try {
    const plan = await overtimeService.getOvertimePlan(req.params.planId);

    if (!plan) {
      return res.status(404).json({ message: 'Overtime plan not found.', code: 'PLAN_NOT_FOUND' });
    }

    if (!(await requireDocumentAccess(req.user, plan))) {
      return res.status(403).json({
        message: 'You do not have permission to access this final document.',
        code: 'FINAL_DOCUMENT_ACCESS_DENIED',
      });
    }

    const finalDocument = await overtimeService.getFinalDocument(plan.planId);

    if (!finalDocument) {
      return res.status(404).json({
        message: 'No final document has been generated for this plan.',
        code: 'FINAL_DOCUMENT_NOT_FOUND',
      });
    }

    if (finalDocument.status !== 'ready') {
      return res.status(409).json({
        message: 'The final Excel document is not ready.',
        code: 'FINAL_DOCUMENT_NOT_READY',
        finalDocument,
      });
    }

    return res.json({
      finalDocument: await overtimeService.createFinalDocumentSignedUrl(finalDocument),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  generateFinalDocument,
  getFinalDocument,
};
