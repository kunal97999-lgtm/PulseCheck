import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../../src/db/pool.js';
import { createRedisConnection } from '../../src/queues/connection.js';
import { createCheckQueue } from '../../src/queues/checkQueue.js';
import { runSchedulerTick, slotJobId } from '../../src/scheduler/tick.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
  cleanups = [];
});

describe('Redis dies during a scheduler tick', () => {
  it('fails fast, leaves schedule and locks untouched, then recovers on the SAME slot', async () => {
    const prefix = `test-${randomUUID()}`;

    const goodConn = createRedisConnection();
    const goodQueue = createCheckQueue({ connection: goodConn, prefix });
    cleanups.push(
      () => goodQueue.obliterate({ force: true }),
      () => goodQueue.close(),
      () => goodConn.quit(),
    );

    const badConn = createRedisConnection({ forApi: true }); // the same options worker.js uses
    const badQueue = createCheckQueue({ connection: badConn, prefix });
    cleanups.push(
      () => Promise.race([badQueue.close(), sleep(1000)]), // may not close cleanly once disconnected
      async () => badConn.disconnect(),
    );
    await badQueue.waitUntilReady();

    const { rows: [user] } = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('f1@example.com', 'x') RETURNING id`,
    );
    const { rows: [m] } = await pool.query(
      `INSERT INTO monitors (user_id, name, url, interval_seconds, next_check_at)
       VALUES ($1, 'm', 'https://example.com/', 3600, now() - interval '30 seconds')
       RETURNING id, next_check_at`,
      [user.id],
    );

    badConn.disconnect(); // Redis "goes away" while the scheduler still holds a queue handle

    const started = Date.now();
    await expect(runSchedulerTick({ queue: badQueue, batchSize: 100 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000); // failed fast, did not hang

    // 1. Nothing was lost: same slot, still due.
    const { rows: [after] } = await pool.query('SELECT next_check_at FROM monitors WHERE id = $1', [m.id]);
    expect(after.next_check_at).toEqual(m.next_check_at);

    // 2. No lock was left behind. NOWAIT errors immediately if another transaction holds the row.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT id FROM monitors WHERE id = $1 FOR UPDATE NOWAIT', [m.id]);
      expect(locked.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    // 3. Redis is back: the next tick issues exactly the job the failed one would have.
    expect(await runSchedulerTick({ queue: goodQueue, batchSize: 100 })).toEqual({ enqueued: 1 });
    expect(await goodQueue.getJob(slotJobId(m.id, m.next_check_at))).toBeTruthy();
  }, 30000);
});