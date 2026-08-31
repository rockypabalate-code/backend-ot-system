const overtimeService = require('../../services/overtimeDbService');

async function listDepartments(req, res, next) {
  try {
    const departments = await overtimeService.getDepartments();
    return res.json({ departments });
  } catch (error) {
    return next(error);
  }
}

async function createDepartment(req, res, next) {
  const { departmentName } = req.body;

  if (!departmentName) {
    return res.status(400).json({ message: 'Department name is required.' });
  }

  try {
    const department = await overtimeService.createDepartment(req.body);
    return res.status(201).json({ department });
  } catch (error) {
    return next(error);
  }
}

async function updateDepartment(req, res, next) {
  try {
    const result = await overtimeService.updateDepartment(req.params.departmentId, req.body || {});
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

async function deleteDepartment(req, res, next) {
  try {
    const result = await overtimeService.deleteDepartment(req.params.departmentId);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  listDepartments,
  createDepartment,
  deleteDepartment,
  updateDepartment,
};
