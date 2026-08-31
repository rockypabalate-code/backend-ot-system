require('dotenv').config({ quiet: true });

const { createClient } = require('@supabase/supabase-js');
const AppError = require('../utils/appError');

let storageClient;

function getStorageClient() {
  if (storageClient) {
    return storageClient;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new AppError(
      'Supabase Storage is not configured.',
      503,
      'SIGNATURE_STORAGE_NOT_CONFIGURED'
    );
  }

  storageClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return storageClient;
}

function getSignatureBucket() {
  return process.env.SUPABASE_SIGNATURE_BUCKET || 'signatures';
}

function getSignatureUrlTtlSeconds() {
  const configuredTtl = Number(process.env.SUPABASE_SIGNED_URL_TTL_SECONDS || 300);
  return Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 300;
}

function getDocumentBucket() {
  return process.env.SUPABASE_DOCUMENT_BUCKET || 'overtime-documents';
}

function getDocumentUrlTtlSeconds() {
  const configuredTtl = Number(process.env.SUPABASE_DOCUMENT_URL_TTL_SECONDS || 300);
  return Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 300;
}

module.exports = {
  getDocumentBucket,
  getDocumentUrlTtlSeconds,
  getSignatureBucket,
  getSignatureUrlTtlSeconds,
  getStorageClient,
};
