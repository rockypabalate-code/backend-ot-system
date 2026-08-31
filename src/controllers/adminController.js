const authService = require('../services/authService');
const overtimeService = require('../services/overtimeDbService');

function dashboard(req, res) {
  return res.json({
    message: 'Welcome to the admin dashboard.',
    user: req.user,
  });
}

async function purgeOvertimeData(req, res, next) {
  try {
    const purgeData = req.body || {};

    await authService.confirmAdminPassword(req.user, purgeData.adminPassword);
    const result = await overtimeService.purgeOvertimeData(
      req.params.departmentPlanId,
      purgeData,
      req.user
    );

    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function impersonateUser(req, res, next) {
  try {
    const result = await authService.createImpersonationSession(req.user, req.body || {});
    return res.json({
      message: 'Admin impersonation session created successfully.',
      ...result,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  dashboard,
  impersonateUser,
  purgeOvertimeData,
};
