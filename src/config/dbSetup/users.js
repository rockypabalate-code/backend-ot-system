const { query } = require('../database');
const userDbService = require('../../services/userDbService');
const { runSetup } = require('./runner');

const starterAdmin = {
  id: 'admin-1',
  firstName: 'Admin',
  middleName: '',
  lastName: 'User',
  email: 'admin@example.com',
  password: 'Admin@123',
  role: 'admin',
  status: 'active',
};

async function createUsersTable() {
  // User names are stored here as the single source of truth.
  // Employee records should link to users through user_id instead of duplicating names.
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      middle_name TEXT,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT users_role_check CHECK (role IN ('admin', 'user', 'hr', 'supervisor', 'japanese_management')),
      CONSTRAINT users_status_check CHECK (status IN ('active', 'pending', 'inactive'))
    );
  `);
}

async function normalizeUserNameColumns() {
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS middle_name TEXT;');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;');
  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'users'
          AND column_name = 'name'
      ) THEN
        UPDATE users
        SET first_name = COALESCE(NULLIF(first_name, ''), split_part(name, ' ', 1), 'User'),
            last_name = COALESCE(NULLIF(last_name, ''), NULLIF(regexp_replace(name, '^.*\\s+', ''), ''), split_part(name, ' ', 1), 'User')
        WHERE first_name IS NULL
           OR last_name IS NULL;
      END IF;
    END $$;
  `);
  await query(`
    UPDATE users
    SET first_name = 'User'
    WHERE first_name IS NULL OR first_name = '';
  `);
  await query(`
    UPDATE users
    SET last_name = first_name
    WHERE last_name IS NULL OR last_name = '';
  `);
  await query('ALTER TABLE users ALTER COLUMN first_name SET NOT NULL;');
  await query('ALTER TABLE users ALTER COLUMN last_name SET NOT NULL;');
  await query('ALTER TABLE users DROP COLUMN IF EXISTS name;');
}

async function normalizeUserRoles() {
  await query(`
    UPDATE users
    SET role = 'supervisor',
        updated_at = NOW()
    WHERE role = 'manager';
  `);

  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'users_role_check'
      ) THEN
        ALTER TABLE users DROP CONSTRAINT users_role_check;
      END IF;
    END $$;
  `);
  await query(`
    ALTER TABLE users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'user', 'hr', 'supervisor', 'japanese_management'));
  `);
}

async function normalizeUserStatusDefault() {
  await query(`
    ALTER TABLE users
    ALTER COLUMN status SET DEFAULT 'active';
  `);
}

async function createUserIndexes() {
  await query(`
    CREATE INDEX IF NOT EXISTS users_email_idx
    ON users (email);
  `);
}

async function createUserSignaturesTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS user_signatures (
      signature_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      signature_file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT user_signatures_status_check CHECK (status IN ('active', 'inactive')),
      CONSTRAINT user_signatures_mime_type_check CHECK (mime_type IN ('image/png', 'image/jpeg'))
    );
  `);
}

async function addUserSignatureUploadedByColumn() {
  await query(
    'ALTER TABLE user_signatures ADD COLUMN IF NOT EXISTS uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL;'
  );
}

async function createAdminImpersonationAuditsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS admin_impersonation_audits (
      impersonation_audit_id TEXT PRIMARY KEY,
      admin_user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      target_role TEXT NOT NULL,
      remarks TEXT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT admin_impersonation_target_role_check
        CHECK (target_role IN ('user', 'supervisor', 'japanese_management'))
    );
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS admin_impersonation_audits_admin_idx
    ON admin_impersonation_audits (admin_user_id, issued_at DESC);
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS admin_impersonation_audits_target_idx
    ON admin_impersonation_audits (target_user_id, issued_at DESC);
  `);
}

async function seedStarterAdmin() {
  await userDbService.upsertUser(starterAdmin);
}

async function setupUsers() {
  await runSetup('users', [
    { name: 'Create users table', run: createUsersTable },
    { name: 'Normalize user name columns', run: normalizeUserNameColumns },
    { name: 'Normalize user roles', run: normalizeUserRoles },
    { name: 'Normalize user status default', run: normalizeUserStatusDefault },
    { name: 'Create user indexes', run: createUserIndexes },
    { name: 'Create user signatures table', run: createUserSignaturesTable },
    { name: 'Add user signature uploader audit', run: addUserSignatureUploadedByColumn },
    { name: 'Create Admin impersonation audit table', run: createAdminImpersonationAuditsTable },
    { name: 'Seed starter admin', run: seedStarterAdmin },
  ]);
}

module.exports = {
  addUserSignatureUploadedByColumn,
  createUserIndexes,
  createUserSignaturesTable,
  createAdminImpersonationAuditsTable,
  createUsersTable,
  normalizeUserNameColumns,
  normalizeUserRoles,
  normalizeUserStatusDefault,
  seedStarterAdmin,
  setupUsers,
};
