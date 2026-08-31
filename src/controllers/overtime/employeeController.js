const overtimeService = require('../../services/overtimeDbService');
const AppError = require('../../utils/appError');

const unrestrictedEmployeeViewRoles = new Set(['admin', 'hr', 'japanese_management']);

function canViewAllEmployees(user) {
  return unrestrictedEmployeeViewRoles.has(user.role);
}

function buildEmployeeFilters(query = {}) {
  return {
    employeeId: query.employeeId,
    userId: query.userId,
    employeeNo: query.employeeNo,
    departmentId: query.departmentId,
    supervisorUserId: query.supervisorUserId,
    shift: query.shift,
    employmentType: query.employmentType,
    status: query.status,
  };
}

async function buildScopedEmployeeFilters(req) {
  const filters = buildEmployeeFilters(req.query);

  if (canViewAllEmployees(req.user)) {
    return filters;
  }

  const supervisorEmployee = await overtimeService.getEmployeeByUserId(req.user.id);

  if (!supervisorEmployee || !supervisorEmployee.departmentId) {
    throw new AppError(
      'Your supervisor account is not linked to a department employee profile.',
      403,
      'SUPERVISOR_EMPLOYEE_PROFILE_REQUIRED'
    );
  }

  return {
    ...filters,
    departmentId: supervisorEmployee.departmentId,
    supervisorUserId: req.user.id,
  };
}

function canSupervisorViewEmployee(user, supervisorEmployee, employee) {
  return Boolean(
    supervisorEmployee
      && employee
      && employee.departmentId === supervisorEmployee.departmentId
      && (employee.supervisorUserId === user.id || employee.userId === user.id)
  );
}

async function listEmployees(req, res, next) {
  try {
    const filters = await buildScopedEmployeeFilters(req);
    const employees = await overtimeService.getEmployees(filters);
    return res.json({ employees });
  } catch (error) {
    return next(error);
  }
}

async function getEmployee(req, res, next) {
  try {
    const employee = await overtimeService.getEmployeeById(req.params.employeeId);

    if (!employee) {
      return res.status(404).json({ message: 'Employee profile not found.' });
    }

    if (!canViewAllEmployees(req.user)) {
      const supervisorEmployee = await overtimeService.getEmployeeByUserId(req.user.id);

      if (!supervisorEmployee || !supervisorEmployee.departmentId) {
        return res.status(403).json({
          message: 'Your supervisor account is not linked to a department employee profile.',
        });
      }

      if (!canSupervisorViewEmployee(req.user, supervisorEmployee, employee)) {
        return res.status(403).json({
          message: 'You do not have permission to view this employee profile.',
        });
      }
    }

    return res.json({ employee });
  } catch (error) {
    return next(error);
  }
}

async function getMyEmployee(req, res, next) {
  try {
    const employee = await overtimeService.getEmployeeByUserId(req.user.id);

    if (!employee) {
      throw new AppError(
        'Employee profile not found.',
        404,
        'EMPLOYEE_NOT_FOUND'
      );
    }

    return res.json({ employee });
  } catch (error) {
    return next(error);
  }
}

async function createEmployee(req, res, next) {
  const { departmentId, userId, shift } = req.body;

  if (!departmentId || !userId || !shift) {
    return res.status(400).json({
      message: 'Department ID, user ID, and shift are required.',
    });
  }

  if (!['day', 'night'].includes(String(shift).toLowerCase().trim())) {
    return res.status(400).json({ message: 'Shift must be day or night.' });
  }

  try {
    const result = await overtimeService.createEmployee(req.body);
    return res.status(result.created ? 201 : 200).json({
      message: result.message,
      employee: result.employee,
    });
  } catch (error) {
    return next(error);
  }
}

async function updateEmployee(req, res, next) {
  const { shift, status } = req.body;

  if (shift !== undefined && !['day', 'night'].includes(String(shift).toLowerCase().trim())) {
    return res.status(400).json({ message: 'Shift must be day or night.' });
  }

  if (status !== undefined && !['active', 'inactive'].includes(String(status).toLowerCase().trim())) {
    return res.status(400).json({ message: 'Employee status must be active or inactive.' });
  }

  try {
    const result = await overtimeService.updateEmployee(req.params.employeeId, req.body);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function deleteEmployee(req, res, next) {
  try {
    const result = await overtimeService.deleteEmployee(req.params.employeeId);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listEmployees,
  getEmployee,
  getMyEmployee,
  createEmployee,
  deleteEmployee,
  updateEmployee,
};
