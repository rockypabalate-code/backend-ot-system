require('dotenv').config({ quiet: true });

const { closePool } = require('./database');
const { setupUsers } = require('./dbSetup/users');

setupUsers()
  .catch((error) => {
    console.error('Failed to set up users.');
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
