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

async function sendActualOvertimeDocument(req, res, next) {
  try {
    const document = await overtimeService.buildActualDocumentDownload(
      req.params.actualPeriodId,
      req.user
    );
    res.setHeader('Content-Type', document.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${document.fileName}"`);
    res.setHeader('Content-Length', document.buffer.length);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(document.buffer);
  } catch (error) {
    return next(error);
  }
}

async function generateActualOvertimeDocument(req, res, next) {
  return sendActualOvertimeDocument(req, res, next);
}

async function getActualOvertimeDocument(req, res, next) {
  return sendActualOvertimeDocument(req, res, next);
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
