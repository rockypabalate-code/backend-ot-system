const authService = require('../services/authService');
const overtimeDbService = require('../services/overtimeDbService');

function normalizeText(value) {
  return String(value || '').trim();
}

async function login(req, res, next) {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res
      .status(400)
      .json({ message: 'Email and password are required.' });
  }

  try {
    const session = await authService.login(email, password);
    return res.json(session);
  } catch (error) {
    return next(error);
  }
}

async function createAccount(req, res, next) {
  const {
    firstName,
    middleName,
    lastName,
    name,
    email,
    password,
    role,
    status,
  } = req.body;

  const hasNameParts = normalizeText(firstName) && normalizeText(lastName);
  const hasFullName = normalizeText(name);

  if ((!hasNameParts && !hasFullName) || !email || !password) {
    return res
      .status(400)
      .json({ message: 'First name and last name or full name, email, and password are required.' });
  }

  try {
    const result = await authService.createAccount({
      firstName,
      middleName,
      lastName,
      name,
      email,
      password,
      role,
      status,
      createdBy: req.user,
    });

    return res.status(201).json(result);
  } catch (error) {
    return next(error);
  }
}

async function listAccounts(req, res, next) {
  try {
    const result = await authService.listAccounts({ requestedBy: req.user });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function updateAccount(req, res, next) {
  try {
    const result = await authService.updateAccount(req.params.userId, req.body, {
      updatedBy: req.user,
    });

    return res.json(result);
  } catch (error) {
    return next(error);
  }
}


async function forceDeleteAccount(req, res, next) {
  try {
    const result = await authService.forceDeleteAccount(req.params.userId, {
      deletedBy: req.user,
      adminPassword: req.body.adminPassword,
    });

    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function deleteAccount(req, res, next) {
  try {
    const result = await authService.deleteAccount(req.params.userId, {
      deletedBy: req.user,
    });

    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function me(req, res, next) {
  try {
    const employeeProfile = req.user.role === 'user'
      ? await overtimeDbService.getEmployeeByUserId(req.user.id)
      : null;

    return res.json({
      user: {
        ...req.user,
        hasEmployeeProfile: req.user.role !== 'user' || Boolean(employeeProfile),
        employeeId: employeeProfile ? employeeProfile.employeeId : null,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createAccount,
  deleteAccount,
  forceDeleteAccount,
  listAccounts,
  login,
  me,
  updateAccount,
  register: createAccount,
};
