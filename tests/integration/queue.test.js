import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRedisConnection } from '../../src/queues/connection.js';
import { createCheckQueue } from '../../src/queues/checkQueue.js';
import { createCheckWorker } from '../../src/workers/checkWorker.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let prefix;
let queue;
let workers;
let connections;

function setup() {
  prefix = `test-${randomUUID()}`;
  workers = [];
  connections = [];
  const qConn = createRedisConnection();
  connections.push(qConn);
  queue = createCheckQueue({ connection: qConn, prefix });
}

function startWorker(processor, concurrency = 1) {
  const conn = createRedisConnection({ forWorker: true });
  connections.push(conn);
  const worker = createCheckWorker({ connection: conn, prefix, processor, concurrency });
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await queue.obliterate({ force: true }).catch(() => {}); // remove this test's keys
  await queue.close();
  await Promise.all(connections.map((c) => c.quit().catch(() => {})));
});

describe('queue and worker basics', () => {
  it('delivers a job to the worker with its payload intact', async () => {
    setup();
    const seen = [];
    startWorker(async (job) => {
      seen.push(job.data);
    });

    await queue.add('check', { monitorId: 'm1', scheduledFor: '2026-01-01T00:00:00.000Z' });
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5000 });
    expect(seen[0]).toEqual({ monitorId: 'm1', scheduledFor: '2026-01-01T00:00:00.000Z' });
  });

  it('never runs more jobs at once than the concurrency setting', async () => {
    setup();
    let active = 0;
    let maxActive = 0;
    let done = 0;
    startWorker(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(100);
      active--;
      done++;
    }, 2);

    for (let i = 0; i < 6; i++) await queue.add('check', { i });
    await vi.waitFor(() => expect(done).toBe(6), { timeout: 8000 });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1); // it really did run in parallel
  });

  it('a graceful close waits for the in-flight job to finish', async () => {
    setup();
    let started = false;
    let finished = false;
    const worker = startWorker(async () => {
      started = true;
      await sleep(500);
      finished = true;
    });

    await queue.add('check', {});
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 5000 });
    await worker.close(); // must not return until the job is done
    expect(finished).toBe(true);
  });

  it('a failing job is recorded as failed and does not stop the worker', async () => {
    setup();
    const processed = [];
    startWorker(async (job) => {
      if (job.data.fail) throw new Error('boom');
      processed.push(job.data.n);
    });

    await queue.add('check', { fail: true });
    await queue.add('check', { n: 2 });

    await vi.waitFor(() => expect(processed).toEqual([2]), { timeout: 5000 });
    const counts = await queue.getJobCounts('failed');
    expect(counts.failed).toBe(1);
  });
});

describe('job ids', () => {
  it('adding the same jobId twice keeps only the first job', async () => {
    setup(); // no worker: jobs stay waiting
    await queue.add('check', { v: 1 }, { jobId: 'slot_1' });
    await queue.add('check', { v: 2 }, { jobId: 'slot_1' });

    const counts = await queue.getJobCounts('waiting');
    expect(counts.waiting).toBe(1);
    expect((await queue.getJob('slot_1')).data).toEqual({ v: 1 });
  });
});