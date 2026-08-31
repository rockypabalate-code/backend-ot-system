require('dotenv').config({ quiet: true });

const { closePool } = require('./database');
const { setupOvertimeTables } = require('./dbSetup/overtime');

setupOvertimeTables()
  .catch((error) => {
    console.error('Failed to set up overtime tables.');
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
