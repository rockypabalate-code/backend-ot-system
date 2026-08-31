require('dotenv').config({ quiet: true });

const { Pool, types } = require('pg');

// Keep PostgreSQL DATE columns as YYYY-MM-DD strings.
// Without this, node-postgres may convert DATE values to local Date objects,
// which can shift a date backward when formatted with toISOString() in UTC+ time zones.
types.setTypeParser(1082, (value) => value);

let pool;

function getPool() {
  if (pool) {
    return pool;
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to connect to PostgreSQL.');
  }

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: false }
      : undefined,
  });

  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function getClient() {
  return getPool().connect();
}

async function transaction(callback) {
  const client = await getClient();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  closePool,
  getClient,
  getPool,
  query,
  transaction,
};
