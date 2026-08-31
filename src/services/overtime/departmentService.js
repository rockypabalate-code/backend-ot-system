const { query, transaction } = require('../../config/database');
const AppError = require('../../utils/appError');

function normalize(value) {
  return String(value || '').trim();
}

function nullable(value) {
  const normalized = normalize(value);
  return normalized || null;
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function mapDepartment(row) {
  return {
    departmentId: row.department_id,
    departmentName: row.department_name,
    parentDepartmentId: row.parent_department_id || '',
    headEmployeeId: row.head_employee_id || '',
    status: row.status,
  };
}

async function getDepartments() {
  const result = await query(`
    SELECT department_id, department_name, parent_department_id, head_employee_id, status
    FROM departments
    ORDER BY COALESCE(parent_department_id, department_id) ASC, parent_department_id NULLS FIRST, department_name ASC;
  `);

  return result.rows.map(mapDepartment);
}

async function createDepartment({ departmentName, parentDepartmentId, headEmployeeId }) {
  const result = await query(
    `
      INSERT INTO departments (department_id, department_name, parent_department_id, head_employee_id, status)
      VALUES ($1, $2, $3, $4, 'active')
      RETURNING department_id, department_name, parent_department_id, head_employee_id, status;
    `,
    [makeId('DEP'), normalize(departmentName), nullable(parentDepartmentId), nullable(headEmployeeId)]
  );

  return mapDepartment(result.rows[0]);
}

async function getDepartmentById(departmentId, executor = { query }) {
  const result = await executor.query(
    `
      SELECT department_id, department_name, parent_department_id, head_employee_id, status
      FROM departments
      WHERE department_id = $1
      LIMIT 1;
    `,
    [normalize(departmentId)]
  );

  return result.rows[0] ? mapDepartment(result.rows[0]) : null;
}

async function updateDepartment(departmentId, updates = {}) {
  const normalizedDepartmentId = normalize(departmentId);

  return transaction(async (client) => {
    const department = await getDepartmentById(normalizedDepartmentId, client);
    if (!department) {
      throw new AppError('Department not found.', 404, 'DEPARTMENT_NOT_FOUND');
    }

    const fields = [];
    const values = [normalizedDepartmentId];
    const addField = (column, value) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (Object.prototype.hasOwnProperty.call(updates, 'departmentName')) {
      const departmentName = normalize(updates.departmentName);
      if (!departmentName) {
        throw new AppError('Department name cannot be empty.', 400, 'DEPARTMENT_NAME_REQUIRED');
      }
      addField('department_name', departmentName);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
      const status = normalize(updates.status).toLowerCase();
      if (!['active', 'inactive'].includes(status)) {
        throw new AppError('Department status must be active or inactive.', 400, 'INVALID_DEPARTMENT_STATUS');
      }
      addField('status', status);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'parentDepartmentId')) {
      const parentDepartmentId = nullable(updates.parentDepartmentId);
      if (parentDepartmentId === normalizedDepartmentId) {
        throw new AppError('A department cannot be its own parent.', 400, 'DEPARTMENT_SELF_PARENT');
      }
      if (parentDepartmentId && !(await getDepartmentById(parentDepartmentId, client))) {
        throw new AppError('Parent department not found.', 404, 'PARENT_DEPARTMENT_NOT_FOUND');
      }
      if (parentDepartmentId) {
        const cycleResult = await client.query(
          `
            WITH RECURSIVE descendants AS (
              SELECT department_id
              FROM departments
              WHERE parent_department_id = $1
              UNION ALL
              SELECT child.department_id
              FROM departments child
              INNER JOIN descendants parent ON child.parent_department_id = parent.department_id
            )
            SELECT 1 FROM descendants WHERE department_id = $2 LIMIT 1;
          `,
          [normalizedDepartmentId, parentDepartmentId]
        );
        if (cycleResult.rows.length > 0) {
          throw new AppError(
            'Parent department cannot be a descendant of this department.',
            400,
            'DEPARTMENT_PARENT_CYCLE'
          );
        }
      }
      addField('parent_department_id', parentDepartmentId);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'headEmployeeId')) {
      const headEmployeeId = nullable(updates.headEmployeeId);
      if (headEmployeeId) {
        const employeeResult = await client.query(
          'SELECT department_id FROM employees WHERE employee_id = $1 LIMIT 1;',
          [headEmployeeId]
        );
        if (employeeResult.rows.length === 0) {
          throw new AppError('Department head employee not found.', 404, 'HEAD_EMPLOYEE_NOT_FOUND');
        }
        if (employeeResult.rows[0].department_id !== normalizedDepartmentId) {
          throw new AppError(
            'Department head employee must belong to this department.',
            400,
            'HEAD_EMPLOYEE_DEPARTMENT_MISMATCH'
          );
        }
      }
      addField('head_employee_id', headEmployeeId);
    }

    if (fields.length === 0) {
      return { department, message: 'No department changes were provided.' };
    }

    fields.push('updated_at = NOW()');
    await client.query(
      `UPDATE departments SET ${fields.join(', ')} WHERE department_id = $1;`,
      values
    );

    return {
      department: await getDepartmentById(normalizedDepartmentId, client),
      message: 'Department updated successfully.',
    };
  });
}

async function deleteDepartment(departmentId) {
  const normalizedDepartmentId = normalize(departmentId);

  return transaction(async (client) => {
    const lockResult = await client.query(
      'SELECT department_id FROM departments WHERE department_id = $1 FOR UPDATE;',
      [normalizedDepartmentId]
    );
    if (lockResult.rows.length === 0) {
      throw new AppError('Department not found.', 404, 'DEPARTMENT_NOT_FOUND');
    }

    const referenceResult = await client.query(
      `
        SELECT
          (SELECT COUNT(*) FROM departments WHERE parent_department_id = $1)::INTEGER AS child_departments,
          (SELECT COUNT(*) FROM employees WHERE department_id = $1)::INTEGER AS employees,
          (SELECT COUNT(*) FROM overtime_plan_approval_routes WHERE department_id = $1)::INTEGER AS approval_routes,
          (SELECT COUNT(*) FROM overtime_plans WHERE department_id = $1)::INTEGER AS overtime_plans,
          (SELECT COUNT(*) FROM overtime_actual_periods WHERE department_id = $1)::INTEGER AS actual_periods;
      `,
      [normalizedDepartmentId]
    );
    const references = referenceResult.rows[0];
    const referenceCount = Object.values(references).reduce((sum, value) => sum + Number(value), 0);

    if (referenceCount > 0) {
      throw new AppError(
        'Department cannot be deleted while child departments, employees, approval routes, OT Plans, or Actual OT periods reference it.',
        409,
        'DEPARTMENT_DELETE_REFERENCED'
      );
    }

    const department = await getDepartmentById(normalizedDepartmentId, client);
    await client.query('DELETE FROM departments WHERE department_id = $1;', [normalizedDepartmentId]);
    return { department, message: 'Department deleted successfully.' };
  });
}

module.exports = {
  createDepartment,
  deleteDepartment,
  getDepartmentById,
  getDepartments,
  updateDepartment,
};
