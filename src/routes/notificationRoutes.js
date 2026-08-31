const express = require('express');
const notificationController = require('../controllers/notificationController');
const { authenticate } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate);
router.get('/', notificationController.listNotifications);
router.get('/unread-count', notificationController.getUnreadCount);
router.patch('/read-all', notificationController.markAllNotificationsRead);
router.patch('/plans/:planId/read', notificationController.markPlanNotificationsRead);
router.patch('/actual-periods/:actualPeriodId/read', notificationController.markActualPeriodNotificationsRead);
router.patch('/:notificationId/read', notificationController.markNotificationRead);

module.exports = router;
