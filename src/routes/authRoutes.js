const express = require('express');
const authController = require('../controllers/authController');
const { authenticate, authorize } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/login', authController.login);
router.post('/register', authenticate, authorize('admin'), authController.createAccount);
router.get('/me', authenticate, authController.me);

module.exports = router;
