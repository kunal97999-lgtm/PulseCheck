import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,                       // max simultaneous connections from this process
  idleTimeoutMillis: 30_000,     // close connections idle for 30s
  connectionTimeoutMillis: 5_000, // fail fast if no connection is available
  query_timeout: 15_000,         // client-side cap so a hung query can't hang a request forever
});

// Without this handler, an error on an IDLE connection (e.g. Postgres restarts)
// is an unhandled 'error' event and crashes the process.
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle PostgreSQL client');
});


export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'ROLLBACK failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}