const express = require('express');
const signatureController = require('../controllers/signatureController');
const { authenticate, authorize } = require('../middleware/authMiddleware');
const uploadSignature = require('../middleware/signatureUploadMiddleware');

const router = express.Router();

router.use(authenticate);
router.post('/signature', authorize('admin'), uploadSignature, signatureController.saveSignature);
router.get('/signature', signatureController.getSignature);
router.delete('/signature/:userId', authorize('admin'), signatureController.deleteSignature);

module.exports = router;
