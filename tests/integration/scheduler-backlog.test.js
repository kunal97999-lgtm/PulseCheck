import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../../src/db/pool.js';
import { createRedisConnection } from '../../src/queues/connection.js';
import { createCheckQueue } from '../../src/queues/checkQueue.js';
import { startScheduler } from '../../src/scheduler/loop.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

let queue;
let connection;

afterEach(async () => {
  await queue.obliterate({ force: true }).catch(() => {});
  await queue.close();
  await connection.quit().catch(() => {});
});

describe('downtime recovery', () => {
  it('drains a backlog larger than one batch immediately, even with a long tick interval', async () => {
    connection = createRedisConnection();
    queue = createCheckQueue({ connection, prefix: `test-${randomUUID()}` });

    const { rows: [user] } = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('backlog@example.com', 'x') RETURNING id`,
    );
    // 25 monitors, all overdue by different amounts (as after an outage).
    await pool.query(
      `INSERT INTO monitors (user_id, name, url, interval_seconds, next_check_at)
       SELECT $1::uuid, 'm' || g, 'https://example.com/', 300, now() - (g * interval '1 second')
         FROM generate_series(1, 25) g`,
      [user.id],
    );

    // Tick interval is 60s, so only "chain immediately when the batch is full" can finish this fast.
    const scheduler = startScheduler({ queue, tickMs: 60_000, batchSize: 10 });
    await vi.waitFor(
      async () => expect((await queue.getJobCounts('waiting')).waiting).toBe(25),
      { timeout: 5000 },
    );
    await scheduler.stop();

    const { rows } = await pool.query(
      `SELECT count(*)::int AS due FROM monitors WHERE next_check_at <= now()`,
    );
    expect(rows[0].due).toBe(0); // everything was claimed and moved into the future
  });
});