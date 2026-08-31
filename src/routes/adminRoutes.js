const express = require('express');
const adminController = require('../controllers/adminController');
const authController = require('../controllers/authController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, authorize('admin'));

router.get('/dashboard', adminController.dashboard);
router.post('/impersonations', adminController.impersonateUser);
router.get('/users', authController.listAccounts);
router.post('/users', authController.createAccount);
router.patch('/users/:userId', authController.updateAccount);
router.delete('/users/:userId/force', authController.forceDeleteAccount);
router.delete('/users/:userId', authController.deleteAccount);
router.post('/overtime/plans/:departmentPlanId/purge-data', adminController.purgeOvertimeData);

module.exports = router;
