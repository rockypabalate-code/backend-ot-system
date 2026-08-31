const { query, transaction } = require('../config/database');
const { createPasswordHash } = require('../config/auth');
const User = require('../models/userModel');
const AppError = require('../utils/appError');

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function splitName(name) {
  const parts = normalizeText(name).split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return { firstName: '', middleName: '', lastName: '' };
  }

  if (parts.length === 1) {
    return { firstName: parts[0], middleName: '', lastName: parts[0] };
  }

  return {
    firstName: parts[0],
    middleName: parts.slice(1, -1).join(' '),
    lastName: parts[parts.length - 1],
  };
}

function normalizeNameParts({ firstName, middleName, lastName, name }) {
  const fallback = splitName(name);

  return {
    firstName: normalizeText(firstName) || fallback.firstName,
    middleName: normalizeText(middleName) || fallback.middleName,
    lastName: normalizeText(lastName) || fallback.lastName,
  };
}

function fullName({ firstName, middleName, lastName }) {
  return [firstName, middleName, lastName].map(normalizeText).filter(Boolean).join(' ');
}

function normalizeRole(role) {
  return String(role || 'user').toLowerCase().trim();
}

function normalizeStatus(status) {
  return String(status || 'active').toLowerCase().trim();
}

function rowToUser(row) {
  if (!row) {
    return null;
  }

  return new User({
    id: row.id,
    firstName: row.first_name,
    middleName: row.middle_name,
    lastName: row.last_name,
    name: row.name || fullName({
      firstName: row.first_name,
      middleName: row.middle_name,
      lastName: row.last_name,
    }),
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
  });
}

const userSelect = `
  SELECT id, first_name, middle_name, last_name, email, password_hash, role, status
  FROM users
`;

async function getUsers(executor = { query }) {
  const result = await executor.query(`
    ${userSelect}
    ORDER BY created_at ASC;
  `);

  return result.rows.map(rowToUser);
}

async function getUserById(userId, executor = { query }) {
  const result = await executor.query(
    `
      ${userSelect}
      WHERE id = $1
      LIMIT 1;
    `,
    [normalizeText(userId)]
  );

  return rowToUser(result.rows[0]);
}

async function getUserByEmail(email, executor = { query }) {
  const result = await executor.query(
    `
      ${userSelect}
      WHERE email = $1
      LIMIT 1;
    `,
    [normalizeEmail(email)]
  );

  return rowToUser(result.rows[0]);
}

async function createUser({ firstName, middleName, lastName, name, email, password, role = 'user', status = 'active' }) {
  const normalizedEmail = normalizeEmail(email);
  const names = normalizeNameParts({ firstName, middleName, lastName, name });
  const result = await query(
    `
      INSERT INTO users (id, first_name, middle_name, last_name, email, password_hash, role, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (email) DO NOTHING
      RETURNING id, first_name, middle_name, last_name, email, password_hash, role, status;
    `,
    [
      `user-${Date.now()}`,
      names.firstName,
      names.middleName || null,
      names.lastName,
      normalizedEmail,
      createPasswordHash(String(password || '')),
      normalizeRole(role),
      normalizeStatus(status),
    ]
  );

  return rowToUser(result.rows[0]);
}

async function updateUser(userId, updates = {}, executor = { query }) {
  const fields = [];
  const values = [normalizeText(userId)];

  function addField(column, value) {
    values.push(value);
    fields.push(`${column} = $${values.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'firstName')) {
    addField('first_name', normalizeText(updates.firstName));
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'middleName')) {
    addField('middle_name', normalizeText(updates.middleName) || null);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'lastName')) {
    addField('last_name', normalizeText(updates.lastName));
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'email')) {
    addField('email', normalizeEmail(updates.email));
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'password')) {
    addField('password_hash', createPasswordHash(String(updates.password || '')));
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'role')) {
    addField('role', normalizeRole(updates.role));
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
    addField('status', normalizeStatus(updates.status));
  }

  if (fields.length === 0) {
    return getUserById(userId, executor);
  }

  fields.push('updated_at = NOW()');

  try {
    const result = await executor.query(
      `
        UPDATE users
        SET ${fields.join(', ')}
        WHERE id = $1
        RETURNING id, first_name, middle_name, last_name, email, password_hash, role, status;
      `,
      values
    );

    return rowToUser(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      throw new AppError('Email is already registered to another account.', 409, 'EMAIL_ALREADY_REGISTERED');
    }

    throw error;
  }
}

async function updateUserStatus(userId, status, executor = { query }) {
  return updateUser(userId, { status }, executor);
}

async function upsertUser({ id, firstName, middleName, lastName, name, email, password, role, status }) {
  const names = normalizeNameParts({ firstName, middleName, lastName, name });
  const result = await query(
    `
      INSERT INTO users (id, first_name, middle_name, last_name, email, password_hash, role, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (email) DO NOTHING
      RETURNING id, first_name, middle_name, last_name, email, password_hash, role, status;
    `,
    [
      normalizeText(id),
      names.firstName,
      names.middleName || null,
      names.lastName,
      normalizeEmail(email),
      createPasswordHash(String(password || '')),
      normalizeRole(role),
      normalizeStatus(status),
    ]
  );

  return rowToUser(result.rows[0]);
}

async function countActiveAdmins(executor = { query }) {
  const result = await executor.query(`
    SELECT COUNT(*)::INTEGER AS count
    FROM users
    WHERE role = 'admin'
      AND status = 'active';
  `);

  return Number(result.rows[0].count || 0);
}

async function getAccountDeleteDependencies(userId, executor = { query }) {
  const normalizedUserId = normalizeText(userId);

  const employeeResult = await executor.query(
    `
      SELECT employee_id
      FROM employees
      WHERE user_id = $1
      LIMIT 1;
    `,
    [normalizedUserId]
  );

  const employeeId = employeeResult.rows[0] ? employeeResult.rows[0].employee_id : null;
  const historyResult = await executor.query(
    `
      SELECT
        (
          (SELECT COUNT(*) FROM overtime_plan_items WHERE employee_id = $2)
          + (SELECT COUNT(*) FROM overtime_plan_signature_records WHERE employee_id = $2)
          + (SELECT COUNT(*) FROM overtime_actual_entries WHERE employee_id = $2)
          + (SELECT COUNT(*) FROM overtime_plans
             WHERE created_by = $1 OR submitted_by = $1 OR approved_by = $1
                OR rejected_by = $1 OR closed_by = $1)
          + (SELECT COUNT(*) FROM overtime_plan_logs WHERE action_by = $1)
          + (SELECT COUNT(*) FROM overtime_plan_approvals WHERE acted_by = $1)
          + (SELECT COUNT(*) FROM overtime_plan_signature_records
             WHERE signature_owner_user_id = $1 OR acted_by_user_id = $1)
          + (SELECT COUNT(*) FROM overtime_actual_periods
             WHERE created_by = $1 OR finalized_by = $1)
          + (SELECT COUNT(*) FROM overtime_actual_entries WHERE last_updated_by = $1)
          + (SELECT COUNT(*) FROM overtime_actual_comments WHERE user_id = $1)
          + (SELECT COUNT(*) FROM overtime_actual_adjustment_logs WHERE changed_by = $1)
        )::INTEGER AS historical_reference_count;
    `,
    [normalizedUserId, employeeId]
  );

  return {
    employeeId,
    historicalReferenceCount: Number(historyResult.rows[0].historical_reference_count || 0),
  };
}

function hasHistoricalReferences(dependencies) {
  return Number(dependencies.historicalReferenceCount) > 0;
}

async function deleteUserAccount(userId, deletedBy) {
  const normalizedUserId = normalizeText(userId);

  if (!deletedBy || deletedBy.role !== 'admin') {
    throw new AppError('Only admin users can delete accounts.', 403, 'ADMIN_ONLY_ACCOUNT_DELETE');
  }

  if (deletedBy.id === normalizedUserId) {
    throw new AppError('You cannot delete your own admin account.', 400, 'CANNOT_DELETE_OWN_ACCOUNT');
  }

  return transaction(async (client) => {
    const user = await getUserById(normalizedUserId, client);

    if (!user) {
      throw new AppError('Account not found.', 404, 'ACCOUNT_NOT_FOUND');
    }

    if (user.role === 'admin' && user.status === 'active') {
      const activeAdminCount = await countActiveAdmins(client);

      if (activeAdminCount <= 1) {
        throw new AppError('Cannot delete the last active admin account.', 400, 'LAST_ACTIVE_ADMIN');
      }
    }

    const dependencies = await getAccountDeleteDependencies(normalizedUserId, client);

    if (hasHistoricalReferences(dependencies)) {
      throw new AppError(
        'This account has OT Plan or Actual OT history and cannot be deleted. Set the account status to inactive instead.',
        409,
        'ACCOUNT_HAS_HISTORY'
      );
    }

    if (dependencies.employeeId) {
      await client.query(
        `
          UPDATE departments
          SET head_employee_id = NULL,
              updated_at = NOW()
          WHERE head_employee_id = $1;
        `,
        [dependencies.employeeId]
      );

      await client.query(
        `
          UPDATE employees
          SET manager_id = NULL,
              updated_at = NOW()
          WHERE manager_id = $1;
        `,
        [dependencies.employeeId]
      );

      await client.query(
        `
          DELETE FROM employees
          WHERE employee_id = $1;
        `,
        [dependencies.employeeId]
      );
    }

    await client.query('DELETE FROM users WHERE id = $1;', [normalizedUserId]);

    return {
      user: user.toJSON(),
      deletedEmployeeId: dependencies.employeeId,
    };
  });
}


async function forceDeleteUserAccount(userId, deletedBy) {
  const normalizedUserId = normalizeText(userId);

  if (!deletedBy || deletedBy.role !== 'admin') {
    throw new AppError('Only admin users can force delete accounts.', 403, 'ADMIN_ONLY_FORCE_ACCOUNT_DELETE');
  }

  if (deletedBy.id === normalizedUserId) {
    throw new AppError('You cannot force delete your own admin account.', 400, 'CANNOT_DELETE_OWN_ACCOUNT');
  }

  return transaction(async (client) => {
    const user = await getUserById(normalizedUserId, client);

    if (!user) {
      throw new AppError('Account not found.', 404, 'ACCOUNT_NOT_FOUND');
    }

    if (user.role === 'admin' && user.status === 'active') {
      const activeAdminCount = await countActiveAdmins(client);

      if (activeAdminCount <= 1) {
        throw new AppError('Cannot delete the last active admin account.', 400, 'LAST_ACTIVE_ADMIN');
      }
    }

    const dependencies = await getAccountDeleteDependencies(normalizedUserId, client);
    let deletedEmployeeId = null;

    if (hasHistoricalReferences(dependencies)) {
      throw new AppError(
        'This account has OT Plan or Actual OT history and cannot be force deleted without corrupting the audit trail. Set the account status to inactive instead.',
        409,
        'ACCOUNT_HAS_HISTORY'
      );
    }

    if (dependencies.employeeId) {
      deletedEmployeeId = dependencies.employeeId;

      await client.query(
        `
          UPDATE departments
          SET head_employee_id = NULL,
              updated_at = NOW()
          WHERE head_employee_id = $1;
        `,
        [dependencies.employeeId]
      );

      await client.query(
        `
          UPDATE employees
          SET manager_id = NULL,
              updated_at = NOW()
          WHERE manager_id = $1;
        `,
        [dependencies.employeeId]
      );

      await client.query(
        `
          DELETE FROM employees
          WHERE employee_id = $1;
        `,
        [dependencies.employeeId]
      );
    }

    await client.query('DELETE FROM users WHERE id = $1;', [normalizedUserId]);

    return {
      user: user.toJSON(),
      deletedEmployeeId,
    };
  });
}

module.exports = {
  countActiveAdmins,
  createUser,
  deleteUserAccount,
  forceDeleteUserAccount,
  getAccountDeleteDependencies,
  getUserByEmail,
  getUserById,
  getUsers,
  updateUser,
  updateUserStatus,
  upsertUser,
};
