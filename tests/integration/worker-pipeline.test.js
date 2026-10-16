import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pool } from '../../src/db/pool.js';
import { createRedisConnection } from '../../src/queues/connection.js';
import { createCheckQueue } from '../../src/queues/checkQueue.js';
import { createCheckWorker } from '../../src/workers/checkWorker.js';
import { createCheckProcessor } from '../../src/workers/processors.js';
import { runSchedulerTick } from '../../src/scheduler/tick.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

let server;
let queue;
let worker;
let connections = [];

afterEach(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => {});
  await queue?.close();
  await Promise.all(connections.map((c) => c.quit().catch(() => {})));
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  worker = queue = server = undefined;
  connections = [];
});

describe('scheduler -> queue -> worker -> database', () => {
  it('stores the result under the scheduler slot, and a duplicate delivery changes nothing', async () => {
    const state = { requests: 0 };
    server = http.createServer((req, res) => {
      state.requests++;
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const policy = { isBlockedIp: () => false, allowedPorts: new Set(['', String(port)]) };

    const user = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('pipe@example.com', 'x') RETURNING id`,
    );
    const { rows: [m] } = await pool.query(
      `INSERT INTO monitors (user_id, name, url, timeout_ms, interval_seconds, next_check_at)
       VALUES ($1, 'm', $2, 3000, 3600, now() - interval '30 seconds')
       RETURNING id, next_check_at`,
      [user.rows[0].id, `http://127.0.0.1:${port}/`],
    );

    const prefix = `test-${randomUUID()}`;
    connections = [createRedisConnection(), createRedisConnection({ forWorker: true })];
    queue = createCheckQueue({ connection: connections[0], prefix });
    worker = createCheckWorker({
      connection: connections[1],
      prefix,
      processor: createCheckProcessor({ policy }),
      concurrency: 2,
    });

    await runSchedulerTick({ queue, batchSize: 100 });

    const results = async () =>
      (await pool.query('SELECT * FROM check_results WHERE monitor_id = $1', [m.id])).rows;
    await vi.waitFor(async () => expect(await results()).toHaveLength(1), { timeout: 8000 });

    const [row] = await results();
    expect(row.scheduled_for).toEqual(m.next_check_at); // the slot survived four hops intact
    expect(row.success).toBe(true);
    const mon = (await pool.query('SELECT current_status FROM monitors WHERE id = $1', [m.id])).rows[0];
    expect(mon.current_status).toBe('up');

    // Simulate Redis delivering the same slot again (different job id, same payload).
    await queue.add(
      'check',
      { monitorId: m.id, scheduledFor: m.next_check_at.toISOString() },
      { jobId: 'redelivery' },
    );
    await vi.waitFor(
      async () => expect((await queue.getJobCounts('completed')).completed).toBe(2),
      { timeout: 8000 },
    );

    expect(state.requests).toBe(2); // executed twice
    expect(await results()).toHaveLength(1); // stored once
    const after = (await pool.query('SELECT consecutive_successes FROM monitors WHERE id = $1', [m.id])).rows[0];
    expect(after.consecutive_successes).toBe(1); // counter not doubled
  });
});