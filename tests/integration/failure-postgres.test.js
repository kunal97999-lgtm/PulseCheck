import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
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

function makeQueue(options = {}) {
  const prefix = `test-${randomUUID()}`;
  const connection = createRedisConnection();
  const queue = createCheckQueue({ connection, prefix, ...options });
  cleanups.push(
    () => queue.obliterate({ force: true }),
    () => queue.close(),
    () => connection.quit(),
  );
  return { queue, prefix };
}

async function makeUser(email) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  );
  return rows[0].id;
}

async function holdWholePool() {
  const held = [];
  for (let i = 0; i < pool.options.max; i++) held.push(await pool.connect());
  return () => held.forEach((c) => c.release());
}

describe('connection pool exhausted', () => {
  it('/ready says 503 quickly, with no details, and recovers when connections return', async () => {
    const app = createApp();
    const release = await holdWholePool();
    try {
      const started = Date.now();
      const res = await request(app).get('/ready');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'not_ready' });
      expect(Date.now() - started).toBeLessThan(4000);
      expect((await request(app).get('/health')).status).toBe(200); // liveness doesn't need the pool
    } finally {
      release();
    }
    expect((await request(app).get('/ready')).status).toBe(200);
  }, 30000);

  it('the scheduler loop survives starvation and catches up afterwards', async () => {
    const { queue } = makeQueue();
    const userId = await makeUser('starve@example.com');
    const { rows: [m] } = await pool.query(
      `INSERT INTO monitors (user_id, name, url, interval_seconds, next_check_at)
       VALUES ($1, 'm', 'https://example.com/', 3600, now() - interval '5 seconds') RETURNING id`,
      [userId],
    );

    const release = await holdWholePool();
    const scheduler = startScheduler({ queue, tickMs: 50, batchSize: 100 });
    cleanups.push(() => scheduler.stop());

    await new Promise((resolve) => setTimeout(resolve, 1500)); // ticks are failing or waiting now
    expect((await queue.getJobCounts('waiting')).waiting).toBe(0);

    release();
    await vi.waitFor(async () => expect((await queue.getJobCounts('waiting')).waiting).toBe(1), {
      timeout: 10000,
    });
    expect(await queue.getJob(`${m.id}_${(await slotOf(m.id)).getTime()}`)).toBeFalsy(); // see note below
  }, 30000);
});

// The monitor's slot was advanced by the tick, so the job id uses the OLD slot.
// We only assert exactly one job exists; the id format is covered by scheduler tests.
async function slotOf(id) {
  const { rows } = await pool.query('SELECT next_check_at FROM monitors WHERE id = $1', [id]);
  return rows[0].next_check_at;
}

describe('a Postgres blip inside a job', () => {
  it('is retried by the queue and the result is stored exactly once', async () => {
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

    const { queue, prefix } = makeQueue({ attempts: 3, backoffMs: 50 });
    const workerConn = createRedisConnection({ forWorker: true });
    const worker = createCheckWorker({
      connection: workerConn,
      prefix,
      processor: createCheckProcessor({ policy }),
      concurrency: 1,
    });
    cleanups.push(() => worker.close(), () => workerConn.quit());

    const userId = await makeUser('blip@example.com');
    const { rows: [m] } = await pool.query(
      `INSERT INTO monitors (user_id, name, url, timeout_ms) VALUES ($1, 'm', $2, 3000) RETURNING id`,
      [userId, `http://127.0.0.1:${port}/`],
    );

    // Set the spy AFTER the inserts above, so only the job's first query fails.
    const spy = vi
      .spyOn(pool, 'query')
      .mockRejectedValueOnce(Object.assign(new Error('terminating connection'), { code: '57P01' }));
    try {
      await queue.add('check', { monitorId: m.id, scheduledFor: '2026-01-01T00:00:00.000Z' });
      await vi.waitFor(
        async () => {
          const { rows } = await pool.query('SELECT count(*)::int AS n FROM check_results');
          expect(rows[0].n).toBe(1);
        },
        { timeout: 8000 },
      );
    } finally {
      spy.mockRestore();
    }

       expect(state.requests).toBe(1); // the failed attempt died before sending anything

    await vi.waitFor(
      async () =>
        expect((await queue.getJobCounts('completed')).completed).toBe(1),
      { timeout: 5000 },
    );
  }, 30000);
});