import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pool } from '../../src/db/pool.js';
import { createRedisConnection } from '../../src/queues/connection.js';
import { createCheckQueue } from '../../src/queues/checkQueue.js';
import { createCheckWorker } from '../../src/workers/checkWorker.js';
import { createCheckProcessor } from '../../src/workers/processors.js';
import { startScheduler } from '../../src/scheduler/loop.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

let cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
  cleanups = [];
});

describe('two live schedulers + a worker', () => {
  it('every due monitor is checked exactly once: 20 requests, 20 rows', async () => {
    const N = 20;
    const state = { requests: 0 };
    const server = http.createServer((req, res) => {
      state.requests++;
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const port = server.address().port;
    const policy = { isBlockedIp: () => false, allowedPorts: new Set(['', String(port)]) };

    const { rows: [user] } = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('multi@example.com', 'x') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO monitors (user_id, name, url, timeout_ms, interval_seconds, next_check_at)
       SELECT $1::uuid, 'm' || g, $2::text, 3000, 3600, now() - (g * interval '1 second')
         FROM generate_series(1, $3::int) g`,
      [user.id, `http://127.0.0.1:${port}/`, N],
    );

    const prefix = `test-${randomUUID()}`;
    const conns = [createRedisConnection(), createRedisConnection(), createRedisConnection({ forWorker: true })];
    const queueA = createCheckQueue({ connection: conns[0], prefix });
    const queueB = createCheckQueue({ connection: conns[1], prefix }); // a second "worker process"
    const worker = createCheckWorker({
      connection: conns[2],
      prefix,
      processor: createCheckProcessor({ policy }),
      concurrency: 5,
    });
    cleanups.push(
      () => worker.close(),
      () => queueA.obliterate({ force: true }),
      () => queueA.close(),
      () => queueB.close(),
      () => Promise.all(conns.map((c) => c.quit())),
    );

    // Small batches and fast ticks maximize the chance the two schedulers collide.
    const schedulerA = startScheduler({ queue: queueA, tickMs: 20, batchSize: 7 });
    const schedulerB = startScheduler({ queue: queueB, tickMs: 20, batchSize: 7 });
    cleanups.push(() => schedulerA.stop(), () => schedulerB.stop());

    const count = async () =>
      (await pool.query('SELECT count(*)::int AS n FROM check_results')).rows[0].n;
    await vi.waitFor(async () => expect(await count()).toBe(N), { timeout: 15000 });

    await new Promise((resolve) => setTimeout(resolve, 500)); // anything extra would show up now
    expect(await count()).toBe(N);
    expect(state.requests).toBe(N); // not just stored once: EXECUTED once

    const { rows } = await pool.query('SELECT count(DISTINCT monitor_id)::int AS n FROM check_results');
    expect(rows[0].n).toBe(N);
    const due = await pool.query(`SELECT count(*)::int AS n FROM monitors WHERE next_check_at <= now()`);
    expect(due.rows[0].n).toBe(0);
  }, 40000);
});