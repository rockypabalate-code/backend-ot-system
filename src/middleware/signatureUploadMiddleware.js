const multer = require('multer');
const AppError = require('../utils/appError');

const signatureUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
  fileFilter(req, file, callback) {
    if (!['image/png', 'image/jpeg'].includes(file.mimetype)) {
      callback(new AppError(
        'Signature must be a PNG or JPEG image.',
        400,
        'INVALID_SIGNATURE_FILE_TYPE'
      ));
      return;
    }

    callback(null, true);
  },
}).single('signature');

function uploadSignature(req, res, next) {
  signatureUpload(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error.code === 'LIMIT_FILE_SIZE') {
      next(new AppError(
        'Signature image must not exceed 2 MB.',
        413,
        'SIGNATURE_FILE_TOO_LARGE'
      ));
      return;
    }

    next(error);
  });
}

module.exports = uploadSignature;
