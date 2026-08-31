const { closePool, query } = require('./database');

const realtimeTables = [
  'departments',
  'employees',
  'overtime_policies',
  'overtime_actual_periods',
  'overtime_actual_entries',
  'overtime_actual_comments',
];

function isDuplicatePublicationError(error) {
  return error && error.code === '42710';
}

async function enableRealtime() {
  for (const tableName of realtimeTables) {
    try {
      await query(`ALTER PUBLICATION supabase_realtime ADD TABLE ${tableName};`);
      console.log(`Realtime enabled for ${tableName}.`);
    } catch (error) {
      if (isDuplicatePublicationError(error)) {
        console.log(`Realtime already enabled for ${tableName}.`);
        continue;
      }

      throw error;
    }
  }
}

enableRealtime()
  .catch((error) => {
    console.error('Failed to enable Supabase Realtime.');
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
