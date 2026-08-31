const { query } = require('../../config/database');
const { toNumber } = require('./shared/utils');

function mapPolicy(row) {
  return {
    policyId: row.policy_id,
    name: row.name,
    minimumHours: toNumber(row.minimum_hours),
    maximumHoursPerDay: toNumber(row.maximum_hours_per_day),
    requiresSupervisorApproval: row.requires_manager_approval ? 'yes' : 'no',
    requiresHrApproval: row.requires_hr_approval ? 'yes' : 'no',
    rateMultiplier: toNumber(row.rate_multiplier),
    status: row.status,
  };
}

async function getPolicies(executor = { query }) {
  const result = await executor.query(`
    SELECT policy_id, name, minimum_hours, maximum_hours_per_day,
           requires_manager_approval, requires_hr_approval, rate_multiplier, status
    FROM overtime_policies
    ORDER BY created_at ASC;
  `);

  return result.rows.map(mapPolicy);
}

async function getActivePolicy(executor = { query }) {
  const result = await executor.query(`
    SELECT policy_id, name, minimum_hours, maximum_hours_per_day,
           requires_manager_approval, requires_hr_approval, rate_multiplier, status
    FROM overtime_policies
    WHERE status = 'active'
    ORDER BY created_at ASC
    LIMIT 1;
  `);

  return result.rows[0] ? mapPolicy(result.rows[0]) : null;
}

module.exports = {
  getActivePolicy,
  getPolicies,
};
