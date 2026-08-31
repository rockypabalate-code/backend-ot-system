const crypto = require('crypto');
const path = require('path');

const tokenSecret = process.env.AUTH_TOKEN_SECRET || 'change-this-secret-in-env';
const tokenExpiresInSeconds = Number(process.env.AUTH_TOKEN_EXPIRES_IN_SECONDS || 60 * 60);
const configuredImpersonationTtl = Number(process.env.ADMIN_IMPERSONATION_TOKEN_EXPIRES_IN_SECONDS || 15 * 60);
const impersonationTokenExpiresInSeconds = Number.isFinite(configuredImpersonationTtl)
  ? Math.min(Math.max(Math.floor(configuredImpersonationTtl), 60), 30 * 60)
  : 15 * 60;


function createPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');

  return `${salt}:${hash}`;
}

module.exports = {
  createPasswordHash,
  impersonationTokenExpiresInSeconds,
  tokenExpiresInSeconds,
  tokenSecret,
  
};
