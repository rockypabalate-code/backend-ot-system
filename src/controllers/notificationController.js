const notificationService = require('../services/notificationService');

function isTrue(value) {
  return value === true || value === 'true' || value === '1';
}

async function listNotifications(req, res, next) {
  try {
    const result = await notificationService.listNotifications(req.user.id, {
      unreadOnly: isTrue(req.query.unreadOnly),
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function getUnreadCount(req, res, next) {
  try {
    const unreadCount = await notificationService.getUnreadNotificationCount(req.user.id);
    return res.json({ unreadCount });
  } catch (error) {
    return next(error);
  }
}

async function markNotificationRead(req, res, next) {
  try {
    const notification = await notificationService.markNotificationRead(req.params.notificationId, req.user.id);
    return res.json({ notification });
  } catch (error) {
    return next(error);
  }
}

async function markAllNotificationsRead(req, res, next) {
  try {
    const updatedCount = await notificationService.markAllNotificationsRead(req.user.id);
    return res.json({ updatedCount });
  } catch (error) {
    return next(error);
  }
}

async function markPlanNotificationsRead(req, res, next) {
  try {
    const updatedCount = await notificationService.markPlanNotificationsRead(req.params.planId, req.user.id);
    return res.json({ updatedCount });
  } catch (error) {
    return next(error);
  }
}

async function markActualPeriodNotificationsRead(req, res, next) {
  try {
    const updatedCount = await notificationService.markActualPeriodNotificationsRead(
      req.params.actualPeriodId,
      req.user.id
    );
    return res.json({ updatedCount });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markActualPeriodNotificationsRead,
  markNotificationRead,
  markPlanNotificationsRead,
};
