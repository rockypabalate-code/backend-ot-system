require('dotenv').config({ quiet: true });

const { closePool } = require('./database');
const { createActualOvertimeTables } = require('./dbSetup/overtime');
const { runStep } = require('./dbSetup/runner');

runStep('Create Actual OT tables and indexes', createActualOvertimeTables)
  .catch((error) => {
    console.error('Failed to create Actual OT tables.');
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
