import { beforeEach, afterAll } from 'vitest';
import { pool, closePool } from '../../src/db/pool.js';

// Safety guard: never run destructive test hooks against a non-test database.
const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
if (!dbName.endsWith('_test')) {
  throw new Error(`Refusing to run tests: database "${dbName}" does not end with "_test"`);
}

export function useTestDb() {
  beforeEach(async () => {
    // CASCADE also empties sessions (and later monitors, results, etc.)
    await pool.query('TRUNCATE users CASCADE');
  });
  afterAll(async () => {
    await closePool();
  });
}