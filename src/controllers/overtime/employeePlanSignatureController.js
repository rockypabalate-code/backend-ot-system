const overtimeService = require('../../services/overtimeDbService');

async function signEmployeeOvertimePlan(req, res, next) {
  try {
    const result = await overtimeService.signEmployeeOvertimePlan(
      req.params.planId,
      req.user,
      req.body || {}
    );

    return res.json({
      message: 'Employee overtime plan signed successfully.',
      ...result,
    });
  } catch (error) {
    return next(error);
  }
}

async function submitAndSignEmployeeOvertimePlan(req, res, next) {
  try {
    const result = await overtimeService.submitAndSignEmployeeOvertimePlan(
      req.params.planId,
      req.user,
      req.body || {}
    );

    return res.json({
      message: 'Employee overtime plan submitted and signed successfully.',
      ...result,
    });
  } catch (error) {
    return next(error);
  }
}

async function withdrawEmployeeOvertimePlan(req, res, next) {
  try {
    const plan = await overtimeService.withdrawEmployeeOvertimePlan(
      req.params.planId,
      req.user,
      req.body || {}
    );

    return res.json({
      message: 'Employee overtime plan withdrawn successfully.',
      plan,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  signEmployeeOvertimePlan,
  submitAndSignEmployeeOvertimePlan,
  withdrawEmployeeOvertimePlan,
};
