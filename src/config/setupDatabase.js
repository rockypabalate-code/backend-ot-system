require('dotenv').config({ quiet: true });

const { closePool } = require('./database');
const { setupUsers } = require('./dbSetup/users');
const { setupOvertimeTables } = require('./dbSetup/overtime');

async function setupDatabase() {
  await setupUsers();
  await setupOvertimeTables();
}

setupDatabase()
  .catch((error) => {
    console.error('Failed to set up database.');
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
