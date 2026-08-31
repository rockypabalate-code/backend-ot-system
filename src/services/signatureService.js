const crypto = require('crypto');
const { query } = require('../config/database');
const {
  getSignatureBucket,
  getSignatureUrlTtlSeconds,
  getStorageClient,
} = require('../config/supabaseStorage');
const AppError = require('../utils/appError');

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function mapSignature(row) {
  return {
    signatureId: row.signature_id,
    userId: row.user_id,
    uploadedBy: row.uploaded_by || '',
    signatureFilePath: row.signature_file_path,
    mimeType: row.mime_type,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function detectImageType(buffer) {
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return { extension: 'png', mimeType: 'image/png' };
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' };
  }

  throw new AppError(
    'Signature must be a valid PNG or JPEG image.',
    400,
    'INVALID_SIGNATURE_FILE'
  );
}

function userStorageSegment(userId) {
  return String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function getUserSignature(userId, executor = { query }) {
  const result = await executor.query(
    `
      SELECT *
      FROM user_signatures
      WHERE user_id = $1
        AND status = 'active'
      LIMIT 1;
    `,
    [userId]
  );

  return result.rows[0] ? mapSignature(result.rows[0]) : null;
}

async function uploadSignatureImage(userId, buffer) {
  const imageType = detectImageType(buffer);
  const filePath = `users/${userStorageSegment(userId)}/${crypto.randomUUID()}.${imageType.extension}`;
  const bucket = getSignatureBucket();
  const { error } = await getStorageClient()
    .storage
    .from(bucket)
    .upload(filePath, buffer, {
      contentType: imageType.mimeType,
      upsert: false,
    });

  if (error) {
    throw new AppError('Unable to upload the signature image.', 502, 'SIGNATURE_UPLOAD_FAILED');
  }

  return {
    bucket,
    filePath,
    mimeType: imageType.mimeType,
  };
}

async function removeSignatureImage(filePath, options = {}) {
  const { error } = await getStorageClient()
    .storage
    .from(getSignatureBucket())
    .remove([filePath]);

  if (error) {
    if (options.strict === true) {
      throw new AppError(
        'Unable to delete the signature image from storage.',
        502,
        'SIGNATURE_DELETE_STORAGE_FAILED'
      );
    }
    console.error('Unable to remove an unused signature upload.', error.message);
    return false;
  }

  return true;
}

async function saveUserSignature(userId, upload, uploadedBy) {
  try {
    const result = await query(
      `
        INSERT INTO user_signatures (
          signature_id,
          user_id,
          uploaded_by,
          signature_file_path,
          mime_type,
          status
        )
        VALUES ($1, $2, $3, $4, $5, 'active')
        ON CONFLICT (user_id)
        DO UPDATE SET
          signature_file_path = EXCLUDED.signature_file_path,
          mime_type = EXCLUDED.mime_type,
          uploaded_by = EXCLUDED.uploaded_by,
          status = 'active',
          updated_at = NOW()
        RETURNING *;
      `,
      [
        `SIGNATURE-${crypto.randomUUID()}`,
        userId,
        uploadedBy,
        upload.filePath,
        upload.mimeType,
      ]
    );

    return mapSignature(result.rows[0]);
  } catch (error) {
    await removeSignatureImage(upload.filePath);
    throw error;
  }
}

async function createSignatureSignedUrl(filePath) {
  const expiresInSeconds = getSignatureUrlTtlSeconds();
  const { data, error } = await getStorageClient()
    .storage
    .from(getSignatureBucket())
    .createSignedUrl(filePath, expiresInSeconds);

  if (error || !data || !data.signedUrl) {
    throw new AppError('Unable to create a signature preview URL.', 502, 'SIGNATURE_URL_FAILED');
  }

  return {
    signedUrl: data.signedUrl,
    expiresInSeconds,
  };
}

async function deleteUserSignature(userId, deletedBy) {
  const normalizedUserId = String(userId || '').trim();
  const signature = await getUserSignature(normalizedUserId);

  if (!signature) {
    throw new AppError('No saved signature was found for the target user.', 404, 'SIGNATURE_NOT_FOUND');
  }

  const referenceResult = await query(
    `
      SELECT
        (SELECT COUNT(*) FROM overtime_plan_signature_records WHERE signature_file_path = $1)::INTEGER AS employee_signatures,
        (SELECT COUNT(*) FROM overtime_plan_approvals WHERE signature_file_path = $1)::INTEGER AS approval_signatures;
    `,
    [signature.signatureFilePath]
  );
  const referenceCount = Object.values(referenceResult.rows[0])
    .reduce((sum, value) => sum + Number(value), 0);

  if (referenceCount > 0) {
    throw new AppError(
      'This signature image is already used by an OT confirmation or approval and cannot be deleted.',
      409,
      'SIGNATURE_IN_USE'
    );
  }

  const inactiveResult = await query(
    `
      UPDATE user_signatures
      SET status = 'inactive', updated_at = NOW()
      WHERE signature_id = $1 AND status = 'active'
      RETURNING signature_id;
    `,
    [signature.signatureId]
  );
  if (inactiveResult.rows.length === 0) {
    throw new AppError('The saved signature was already changed.', 409, 'SIGNATURE_CHANGED');
  }

  try {
    await removeSignatureImage(signature.signatureFilePath, { strict: true });
    await query('DELETE FROM user_signatures WHERE signature_id = $1 AND status = $2;', [signature.signatureId, 'inactive']);
  } catch (error) {
    await query(
      `UPDATE user_signatures SET status = 'active', updated_at = NOW() WHERE signature_id = $1 AND status = 'inactive';`,
      [signature.signatureId]
    ).catch(() => {});
    throw error;
  }

  return {
    deletedSignature: signature,
    deletedBy: String(deletedBy || '').trim(),
    storageFileDeleted: true,
  };
}

module.exports = {
  createSignatureSignedUrl,
  deleteUserSignature,
  getUserSignature,
  removeSignatureImage,
  saveUserSignature,
  uploadSignatureImage,
};
