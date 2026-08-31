const signatureService = require('../services/signatureService');
const userDbService = require('../services/userDbService');
const AppError = require('../utils/appError');

async function addPreviewUrl(signature) {
  const preview = await signatureService.createSignatureSignedUrl(signature.signatureFilePath);
  return {
    ...signature,
    ...preview,
  };
}

async function saveSignature(req, res, next) {
  if (!req.file || !req.file.buffer) {
    return next(new AppError(
      'A signature image is required in the signature form-data field.',
      400,
      'SIGNATURE_FILE_REQUIRED'
    ));
  }

  try {
    const targetUserId = String(
      (req.body && (req.body.userId || req.body.targetUserId)) || ''
    ).trim();

    if (!targetUserId) {
      throw new AppError(
        'Target user ID is required in the userId form-data field.',
        400,
        'SIGNATURE_USER_ID_REQUIRED'
      );
    }

    const targetUser = await userDbService.getUserById(targetUserId);

    if (!targetUser) {
      throw new AppError('Target user not found.', 404, 'SIGNATURE_USER_NOT_FOUND');
    }

    const upload = await signatureService.uploadSignatureImage(targetUserId, req.file.buffer);
    const signature = await signatureService.saveUserSignature(targetUserId, upload, req.user.id);

    return res.json({
      message: 'Signature saved for the target user successfully.',
      signature: await addPreviewUrl(signature),
    });
  } catch (error) {
    return next(error);
  }
}

async function getSignature(req, res, next) {
  try {
    const signature = await signatureService.getUserSignature(req.user.id);

    if (!signature) {
      throw new AppError('No saved signature was found.', 404, 'SIGNATURE_NOT_FOUND');
    }

    return res.json({ signature: await addPreviewUrl(signature) });
  } catch (error) {
    return next(error);
  }
}

async function deleteSignature(req, res, next) {
  try {
    const result = await signatureService.deleteUserSignature(req.params.userId, req.user.id);
    return res.json({
      message: 'Saved signature deleted successfully.',
      ...result,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  deleteSignature,
  getSignature,
  saveSignature,
};
