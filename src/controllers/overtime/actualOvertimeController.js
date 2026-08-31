const overtimeService = require('../../services/overtimeDbService');

async function listActualOvertimePeriods(req, res, next) {
  try {
    const actualPeriods = await overtimeService.listActualPeriods(req.query || {}, req.user);
    return res.json({ actualPeriods });
  } catch (error) {
    return next(error);
  }
}

async function getActualOvertimePeriod(req, res, next) {
  try {
    const actualPeriod = await overtimeService.getActualPeriod(
      req.params.actualPeriodId,
      req.user
    );
    return res.json({ actualPeriod });
  } catch (error) {
    return next(error);
  }
}

async function updateActualOvertimeEntry(req, res, next) {
  try {
    const actualEntry = await overtimeService.updateActualEntry(
      req.params.actualEntryId,
      req.body || {},
      req.user
    );
    return res.json({
      message: 'Actual OT entry updated successfully.',
      actualEntry,
    });
  } catch (error) {
    return next(error);
  }
}

async function addActualOvertimeComment(req, res, next) {
  try {
    const comment = await overtimeService.addActualEntryComment(
      req.params.actualEntryId,
      req.body && req.body.remarks,
      req.user
    );
    return res.status(201).json({
      message: 'Actual OT comment added successfully.',
      comment,
    });
  } catch (error) {
    return next(error);
  }
}

async function finalizeActualOvertimePeriod(req, res, next) {
  try {
    const actualPeriod = await overtimeService.finalizeActualPeriod(
      req.params.actualPeriodId,
      req.body && req.body.remarks,
      req.user
    );
    return res.json({
      message: 'Actual OT period finalized successfully.',
      actualPeriod,
    });
  } catch (error) {
    return next(error);
  }
}

async function generateActualOvertimeDocument(req, res, next) {
  try {
    const document = await overtimeService.generateActualDocument(
      req.params.actualPeriodId,
      req.user,
      { force: req.body && req.body.force === true }
    );
    return res.json({
      message: 'Final Actual OT Excel document generated successfully.',
      finalDocument: await overtimeService.createActualDocumentSignedUrl(document),
    });
  } catch (error) {
    return next(error);
  }
}

async function getActualOvertimeDocument(req, res, next) {
  try {
    const document = await overtimeService.getActualDocument(
      req.params.actualPeriodId,
      req.user
    );
    if (!document) {
      return res.status(404).json({
        message: 'No final Actual OT document has been generated for this period.',
        code: 'ACTUAL_DOCUMENT_NOT_FOUND',
      });
    }
    if (document.status !== 'ready') {
      return res.status(409).json({
        message: 'The final Actual OT Excel document is not ready.',
        code: 'ACTUAL_DOCUMENT_NOT_READY',
        finalDocument: document,
      });
    }
    return res.json({
      finalDocument: await overtimeService.createActualDocumentSignedUrl(document),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  addActualOvertimeComment,
  finalizeActualOvertimePeriod,
  generateActualOvertimeDocument,
  getActualOvertimeDocument,
  getActualOvertimePeriod,
  listActualOvertimePeriods,
  updateActualOvertimeEntry,
};
