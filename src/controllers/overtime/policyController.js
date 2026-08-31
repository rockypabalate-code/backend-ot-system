const overtimeService = require('../../services/overtimeDbService');

async function listPolicies(req, res, next) {
  try {
    const policies = await overtimeService.getPolicies();
    return res.json({ policies });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listPolicies,
};
