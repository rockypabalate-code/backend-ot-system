const { closePool, query } = require('./database');

async function testDatabaseConnection() {
  try {
    const result = await query('SELECT NOW() AS connected_at');
    console.log('PostgreSQL connected successfully.');
    console.log(`Connected at: ${result.rows[0].connected_at.toISOString()}`);
  } finally {
    await closePool();
  }
}

testDatabaseConnection().catch((error) => {
  console.error('PostgreSQL connection failed.');
  console.error(error.message);
  process.exit(1);
});
