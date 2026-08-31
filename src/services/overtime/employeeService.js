const { query, transaction } = require('../../config/database');
const userDbService = require('../userDbService');
const AppError = require('../../utils/appError');

function normalize(value) {
  return String(value || '').trim();
}

function nullable(value) {
  const normalized = normalize(value);
  return normalized || null;
}

function buildFullName({ firstName, middleName, lastName }) {
  return [firstName, middleName, lastName].map(normalize).filter(Boolean).join(' ');
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeShift(value) {
  const shift = normalize(value).toLowerCase();
  return ['day', 'night'].includes(shift) ? shift : 'day';
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value || '';
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function mapEmployee(row) {
  const firstName = row.user_first_name || '';
  const middleName = row.user_middle_name || '';
  const lastName = row.user_last_name || '';

  return {
    employeeId: row.employee_id,
    userId: row.user_id,
    employeeNo: row.employee_no || '',
    firstName,
    middleName,
    lastName,
    fullName: buildFullName({ firstName, middleName, lastName }),
    email: row.user_email || '',
    departmentId: row.department_id,
    departmentName: row.department_name || '',
    position: row.position || '',
    supervisorUserId: row.supervisor_user_id || '',
    supervisorName: buildFullName({
      firstName: row.supervisor_first_name || '',
      middleName: row.supervisor_middle_name || '',
      lastName: row.supervisor_last_name || '',
    }),
    shift: row.shift,
    employmentType: row.employment_type,
    status: row.status,
    userStatus: row.user_status || '',
    createdAt: iso(row.created_at),
  };
}

const employeeSelect = `
  SELECT
    e.employee_id,
    e.user_id,
    e.employee_no,
    e.department_id,
    d.department_name,
    e.position,
    e.supervisor_user_id,
    e.shift,
    e.employment_type,
    e.status,
    e.created_at,
    u.first_name AS user_first_name,
    u.middle_name AS user_middle_name,
    u.last_name AS user_last_name,
    u.email AS user_email,
    u.status AS user_status,
    supervisor_user.first_name AS supervisor_first_name,
    supervisor_user.middle_name AS supervisor_middle_name,
    supervisor_user.last_name AS supervisor_last_name
  FROM employees e
  INNER JOIN users u ON u.id = e.user_id
  LEFT JOIN departments d ON d.department_id = e.department_id
  LEFT JOIN users supervisor_user ON supervisor_user.id = e.supervisor_user_id
`;

function isQueryExecutor(value) {
  return value && typeof value.query === 'function';
}

function addEmployeeFilter(clauses, values, column, value) {
  const normalizedValue = normalize(value);

  if (!normalizedValue) {
    return;
  }

  values.push(normalizedValue);
  clauses.push(`${column} = $${values.length}`);
}

async function getEmployees(filters = {}, executor = { query }) {
  if (isQueryExecutor(filters)) {
    executor = filters;
    filters = {};
  }

  filters = filters || {};

  const clauses = [];
  const values = [];

  addEmployeeFilter(clauses, values, 'e.employee_id', filters.employeeId);
  addEmployeeFilter(clauses, values, 'e.user_id', filters.userId);
  addEmployeeFilter(clauses, values, 'e.employee_no', filters.employeeNo);
  addEmployeeFilter(clauses, values, 'e.department_id', filters.departmentId);
  addEmployeeFilter(clauses, values, 'e.supervisor_user_id', filters.supervisorUserId);
  addEmployeeFilter(clauses, values, 'e.shift', filters.shift);
  addEmployeeFilter(clauses, values, 'e.employment_type', filters.employmentType);
  addEmployeeFilter(clauses, values, 'e.status', filters.status);

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const result = await executor.query(
    `
      ${employeeSelect}
      ${whereClause}
      ORDER BY e.created_at ASC;
    `,
    values
  );

  return result.rows.map(mapEmployee);
}

async function getEmployeeByUserId(userId, executor = { query }) {
  const result = await executor.query(
    `
      ${employeeSelect}
      WHERE e.user_id = $1
      LIMIT 1;
    `,
    [normalize(userId)]
  );

  return result.rows[0] ? mapEmployee(result.rows[0]) : null;
}

async function getEmployeeById(employeeId, executor = { query }) {
  const result = await executor.query(
    `
      ${employeeSelect}
      WHERE e.employee_id = $1
      LIMIT 1;
    `,
    [normalize(employeeId)]
  );

  return result.rows[0] ? mapEmployee(result.rows[0]) : null;
}

async function generateEmployeeNo(executor = { query }) {
  const result = await executor.query(`
    SELECT COALESCE(MAX(substring(employee_no FROM '^EMP-([0-9]+)$')::INTEGER), 0) AS last_number
    FROM employees
    WHERE employee_no ~ '^EMP-[0-9]+$';
  `);

  const nextNumber = toNumber(result.rows[0].last_number) + 1;
  return `EMP-${String(nextNumber).padStart(3, '0')}`;
}

async function validateSupervisorUserId(supervisorUserId, executor = { query }) {
  const normalizedSupervisorUserId = nullable(supervisorUserId);

  if (!normalizedSupervisorUserId) {
    return null;
  }

  const result = await executor.query(
    `
      SELECT id, role, status
      FROM users
      WHERE id = $1
      LIMIT 1;
    `,
    [normalizedSupervisorUserId]
  );

  if (result.rows.length === 0) {
    throw new AppError('Supervisor user not found.', 404, 'SUPERVISOR_USER_NOT_FOUND');
  }

  const supervisor = result.rows[0];

  if (!['supervisor', 'admin'].includes(supervisor.role)) {
    throw new AppError('Supervisor user must have supervisor or admin role.', 400, 'INVALID_SUPERVISOR_ROLE');
  }

  if (supervisor.status !== 'active') {
    throw new AppError('Supervisor user must be active.', 400, 'INACTIVE_SUPERVISOR_USER');
  }

  return normalizedSupervisorUserId;
}

async function createEmployee(employeeData) {
  const userId = normalize(employeeData.userId);
  const user = await userDbService.getUserById(userId);

  if (!user) {
    throw new AppError('User ID does not exist.', 404, 'USER_NOT_FOUND');
  }

  return transaction(async (client) => {
    const supervisorUserId = await validateSupervisorUserId(employeeData.supervisorUserId, client);
    const existingEmployee = await getEmployeeByUserId(userId, client);

    if (existingEmployee) {
      const result = await client.query(
        `
          UPDATE employees
          SET department_id = $2,
              position = $3,
              supervisor_user_id = $4,
              shift = $5,
              employment_type = $6,
              updated_at = NOW()
          WHERE user_id = $1
          RETURNING employee_id;
        `,
        [
          userId,
          normalize(employeeData.departmentId) || existingEmployee.departmentId,
          nullable(employeeData.position) || existingEmployee.position || null,
          supervisorUserId || existingEmployee.supervisorUserId || null,
          normalizeShift(employeeData.shift || existingEmployee.shift),
          normalize(employeeData.employmentType) || existingEmployee.employmentType || 'regular',
        ]
      );

      const employee = await getEmployeeById(result.rows[0].employee_id, client);
      await userDbService.updateUserStatus(userId, 'active', client);

      return {
        created: false,
        employee,
        message: 'This user already has an employee profile. Account has been activated.',
      };
    }

    await client.query('LOCK TABLE employees IN SHARE ROW EXCLUSIVE MODE;');

    const employeeNo = await generateEmployeeNo(client);
    const employeeId = makeId('EMP');

    const result = await client.query(
      `
        INSERT INTO employees (
          employee_id,
          user_id,
          employee_no,
          department_id,
          position,
          supervisor_user_id,
          shift,
          employment_type,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
        RETURNING employee_id;
      `,
      [
        employeeId,
        userId,
        employeeNo,
        normalize(employeeData.departmentId),
        nullable(employeeData.position),
        supervisorUserId,
        normalizeShift(employeeData.shift),
        normalize(employeeData.employmentType) || 'regular',
      ]
    );

    const employee = await getEmployeeById(result.rows[0].employee_id, client);
    await userDbService.updateUserStatus(userId, 'active', client);

    return {
      created: true,
      employee,
      message: 'Employee profile created and account activated.',
    };
  });
}

function normalizeEmployeeStatus(value) {
  const status = normalize(value || 'active').toLowerCase();
  return ['active', 'inactive'].includes(status) ? status : null;
}

async function updateEmployee(employeeId, updates = {}) {
  const normalizedEmployeeId = normalize(employeeId);
  const existingEmployee = await getEmployeeById(normalizedEmployeeId);

  if (!existingEmployee) {
    throw new AppError('Employee profile not found.', 404, 'EMPLOYEE_NOT_FOUND');
  }

  const fields = [];
  const values = [normalizedEmployeeId];

  function addField(column, value) {
    values.push(value);
    fields.push(`${column} = $${values.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'departmentId')) {
    const departmentId = normalize(updates.departmentId);

    if (!departmentId) {
      throw new AppError('Department ID cannot be empty.', 400, 'DEPARTMENT_ID_REQUIRED');
    }

    addField('department_id', departmentId);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'position')) {
    addField('position', nullable(updates.position));
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'supervisorUserId')) {
    const supervisorUserId = await validateSupervisorUserId(updates.supervisorUserId);
    addField('supervisor_user_id', supervisorUserId);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'shift')) {
    const shift = normalize(updates.shift).toLowerCase();

    if (!['day', 'night'].includes(shift)) {
      throw new AppError('Shift must be day or night.', 400, 'INVALID_SHIFT');
    }

    addField('shift', shift);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'employmentType')) {
    addField('employment_type', normalize(updates.employmentType) || 'regular');
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
    const status = normalizeEmployeeStatus(updates.status);

    if (!status) {
      throw new AppError('Employee status must be active or inactive.', 400, 'INVALID_EMPLOYEE_STATUS');
    }

    addField('status', status);
  }

  if (fields.length === 0) {
    return {
      employee: existingEmployee,
      message: 'No employee profile changes were provided.',
    };
  }

  fields.push('updated_at = NOW()');

  const result = await query(
    `
      UPDATE employees
      SET ${fields.join(', ')}
      WHERE employee_id = $1
      RETURNING employee_id;
    `,
    values
  );

  const employee = await getEmployeeById(result.rows[0].employee_id);

  return {
    employee,
    message: 'Employee profile updated successfully.',
  };
}

async function deleteEmployee(employeeId) {
  const normalizedEmployeeId = normalize(employeeId);

  return transaction(async (client) => {
    const lockResult = await client.query(
      'SELECT employee_id FROM employees WHERE employee_id = $1 FOR UPDATE;',
      [normalizedEmployeeId]
    );
    if (lockResult.rows.length === 0) {
      throw new AppError('Employee profile not found.', 404, 'EMPLOYEE_NOT_FOUND');
    }

    const employee = await getEmployeeById(normalizedEmployeeId, client);
    const referenceResult = await client.query(
      `
        SELECT
          (SELECT COUNT(*) FROM departments WHERE head_employee_id = $1)::INTEGER AS headed_departments,
          (SELECT COUNT(*) FROM employees WHERE supervisor_user_id = $2)::INTEGER AS supervised_employees,
          (SELECT COUNT(*) FROM employees WHERE manager_id = $1)::INTEGER AS managed_employees,
          (SELECT COUNT(*) FROM overtime_plan_items WHERE employee_id = $1)::INTEGER AS plan_items,
          (SELECT COUNT(*) FROM overtime_plan_signature_records WHERE employee_id = $1)::INTEGER AS signature_records,
          (SELECT COUNT(*) FROM overtime_actual_entries WHERE employee_id = $1)::INTEGER AS actual_entries;
      `,
      [normalizedEmployeeId, employee.userId]
    );
    const references = referenceResult.rows[0];
    const referenceCount = Object.values(references).reduce((sum, value) => sum + Number(value), 0);

    if (referenceCount > 0) {
      throw new AppError(
        'Employee profile cannot be deleted while department leadership, managed employees, supervised employees, OT Plans, signatures, or Actual OT entries reference it.',
        409,
        'EMPLOYEE_DELETE_REFERENCED'
      );
    }

    await client.query('DELETE FROM employees WHERE employee_id = $1;', [normalizedEmployeeId]);
    return {
      employee,
      userAccountRetained: true,
      message: 'Employee profile deleted successfully. The linked user account was retained.',
    };
  });
}

module.exports = {
  createEmployee,
  deleteEmployee,
  getEmployeeById,
  getEmployeeByUserId,
  getEmployees,
  updateEmployee,
};
