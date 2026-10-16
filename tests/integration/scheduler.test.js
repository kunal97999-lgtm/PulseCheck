import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../../src/db/pool.js';
import { createRedisConnection } from '../../src/queues/connection.js';
import { createCheckQueue } from '../../src/queues/checkQueue.js';
import { runSchedulerTick, slotJobId } from '../../src/scheduler/tick.js';
import { startScheduler } from '../../src/scheduler/loop.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

let queue;
let connection;

function setup() {
  connection = createRedisConnection();
  queue = createCheckQueue({ connection, prefix: `test-${randomUUID()}` });
}

afterEach(async () => {
  await queue.obliterate({ force: true }).catch(() => {});
  await queue.close();
  await connection.quit().catch(() => {});
});

async function makeUser() {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ('sched@example.com', 'x') RETURNING id`,
  );
  return rows[0].id;
}

// offsetSec: negative = due in the past, positive = due in the future.
async function insertMonitor(userId, { intervalSeconds = 300, isActive = true, offsetSec = -1 } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO monitors (user_id, name, url, interval_seconds, is_active, next_check_at)
     VALUES ($1, 'm', 'https://example.com/', $2::int, $3::boolean,
             CASE WHEN $3::boolean THEN now() + ($4::int * interval '1 second') END)
     RETURNING id, next_check_at`,
    [userId, intervalSeconds, isActive, offsetSec],
  );
  return rows[0];
}

const waiting = async () => (await queue.getJobCounts('waiting')).waiting;
const nextCheck = async (id) =>
  (
    await pool.query(
      `SELECT next_check_at,
              next_check_at > now() AS in_future,
              next_check_at <= now() + (interval_seconds * interval '1 second') AS within_one_interval
         FROM monitors WHERE id = $1`,
      [id],
    )
  ).rows[0];

describe('runSchedulerTick', () => {
  it('enqueues a due monitor; scheduledFor is the SLOT, not the clock', async () => {
    setup();
    const m = await insertMonitor(await makeUser(), { offsetSec: -30 });

    expect(await runSchedulerTick({ queue, batchSize: 100 })).toEqual({ enqueued: 1 });

    const job = await queue.getJob(slotJobId(m.id, m.next_check_at));
    expect(job).toBeTruthy();
    expect(job.data).toEqual({ monitorId: m.id, scheduledFor: m.next_check_at.toISOString() });
    expect(new Date(job.data.scheduledFor) < new Date(Date.now() - 20_000)).toBe(true); // ~30s old
  });

  it('moves next_check_at into the future, at most one interval ahead', async () => {
    setup();
    const m = await insertMonitor(await makeUser(), { offsetSec: -1, intervalSeconds: 300 });
    await runSchedulerTick({ queue, batchSize: 100 });
    const row = await nextCheck(m.id);
    expect(row.in_future).toBe(true);
    expect(row.within_one_interval).toBe(true);
  });

  it('a second tick right after enqueues nothing', async () => {
    setup();
    await insertMonitor(await makeUser());
    await runSchedulerTick({ queue, batchSize: 100 });
    expect(await runSchedulerTick({ queue, batchSize: 100 })).toEqual({ enqueued: 0 });
    expect(await waiting()).toBe(1);
  });

  it('skips missed slots: one overdue hour means ONE job, not twelve', async () => {
    setup();
    const m = await insertMonitor(await makeUser(), { offsetSec: -3600, intervalSeconds: 300 });

    expect(await runSchedulerTick({ queue, batchSize: 100 })).toEqual({ enqueued: 1 });
    expect(await waiting()).toBe(1);

    // The one job carries the OLD slot as its key...
    const job = await queue.getJob(slotJobId(m.id, m.next_check_at));
    expect(job.data.scheduledFor).toBe(m.next_check_at.toISOString());
    // ...and the schedule lands on the next future slot.
    const row = await nextCheck(m.id);
    expect(row.in_future).toBe(true);
    expect(row.within_one_interval).toBe(true);
  });

  it('ignores monitors that are not due yet, and paused monitors', async () => {
    setup();
    const userId = await makeUser();
    await insertMonitor(userId, { offsetSec: 60 });
    await insertMonitor(userId, { isActive: false });
    expect(await runSchedulerTick({ queue, batchSize: 100 })).toEqual({ enqueued: 0 });
    expect(await waiting()).toBe(0);
  });

  it('respects batchSize and takes the oldest slots first', async () => {
    setup();
    const userId = await makeUser();
    const ms = [];
    for (const offsetSec of [-50, -40, -30, -20, -10]) ms.push(await insertMonitor(userId, { offsetSec }));

    expect(await runSchedulerTick({ queue, batchSize: 2 })).toEqual({ enqueued: 2 });
    expect(await queue.getJob(slotJobId(ms[0].id, ms[0].next_check_at))).toBeTruthy();
    expect(await queue.getJob(slotJobId(ms[1].id, ms[1].next_check_at))).toBeTruthy();
    expect(await queue.getJob(slotJobId(ms[4].id, ms[4].next_check_at))).toBeFalsy();

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM monitors WHERE next_check_at <= now()`);
    expect(rows[0].n).toBe(3); // still due, picked up by the next tick
  });

  it('two concurrent tickers claim each monitor exactly once (SKIP LOCKED)', async () => {
    setup();
    const userId = await makeUser();
    for (let i = 0; i < 5; i++) await insertMonitor(userId, { offsetSec: -(i + 1) });

    const results = await Promise.all([
      runSchedulerTick({ queue, batchSize: 100 }),
      runSchedulerTick({ queue, batchSize: 100 }),
    ]);

    // Job ids dedupe in Redis, so queue depth alone would not prove exclusivity.
    // The sum of what each ticker CLAIMED does.
    expect(results[0].enqueued + results[1].enqueued).toBe(5);
    expect(await waiting()).toBe(5);
  });

  it('rolls back the schedule if enqueueing fails, then retries the SAME slot', async () => {
    setup();
    const m = await insertMonitor(await makeUser(), { offsetSec: -30 });
    const brokenQueue = {
      addBulk: async () => {
        throw new Error('redis is down');
      },
    };

    await expect(runSchedulerTick({ queue: brokenQueue, batchSize: 100 })).rejects.toThrow('redis is down');

    // Nothing was lost: the monitor is still due, with its original slot.
    const { rows } = await pool.query(`SELECT next_check_at FROM monitors WHERE id = $1`, [m.id]);
    expect(rows[0].next_check_at).toEqual(m.next_check_at);

    // Redis recovers: the next tick issues the same job id as the failed attempt would have.
    expect(await runSchedulerTick({ queue, batchSize: 100 })).toEqual({ enqueued: 1 });
    expect(await queue.getJob(slotJobId(m.id, m.next_check_at))).toBeTruthy();
  });
});

describe('startScheduler (the loop)', () => {
  it('picks up work on its own and stops cleanly', async () => {
    setup();
    const m = await insertMonitor(await makeUser(), { offsetSec: -5, intervalSeconds: 3600 });
    const scheduler = startScheduler({ queue, tickMs: 50, batchSize: 100 });

    await vi.waitFor(async () => expect(await waiting()).toBe(1), { timeout: 5000 });
    expect(await queue.getJob(slotJobId(m.id, m.next_check_at))).toBeTruthy();

    await scheduler.stop(); // resolves only after any in-progress tick finishes

    // A monitor that becomes due after stop() is not picked up.
    const late = await insertMonitor(await makeUser2(), { offsetSec: -1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await queue.getJob(slotJobId(late.id, late.next_check_at))).toBeFalsy();
  });
});

async function makeUser2() {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ('sched2@example.com', 'x') RETURNING id`,
  );
  return rows[0].id;
}