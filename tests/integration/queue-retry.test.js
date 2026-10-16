import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { createRedisConnection } from '../../src/queues/connection.js';
import { createCheckQueue } from '../../src/queues/checkQueue.js';
import { createCheckWorker } from '../../src/workers/checkWorker.js';

let prefix;
let queue;
let worker;
let connections;

function setup(options) {
  prefix = `test-${randomUUID()}`;
  connections = [createRedisConnection(), createRedisConnection({ forWorker: true })];
  queue = createCheckQueue({ connection: connections[0], prefix, ...options });
}
function startWorker(processor) {
  worker = createCheckWorker({ connection: connections[1], prefix, processor, concurrency: 1 });
}
const count = async (state) => (await queue.getJobCounts(state))[state];

afterEach(async () => {
  await worker?.close();
  await queue.obliterate({ force: true }).catch(() => {});
  await queue.close();
  await Promise.all(connections.map((c) => c.quit().catch(() => {})));
  worker = undefined;
});

describe('retry policy', () => {
  it('retries a transient failure with exponential backoff, then completes', async () => {
    setup({ attempts: 3, backoffMs: 50 });
    const times = [];
    startWorker(async () => {
      times.push(Date.now());
      if (times.length < 3) throw new Error('transient');
    });

    await queue.add('check', {});
    await vi.waitFor(async () => expect(await count('completed')).toBe(1), { timeout: 8000 });

    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(40); // ~50ms
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(80); // ~100ms: it doubled
  });

  it('gives up after the attempt limit and keeps the failed job for inspection', async () => {
    setup({ attempts: 3, backoffMs: 20 });
    let calls = 0;
    startWorker(async () => {
      calls++;
      throw new Error('always broken');
    });

    await queue.add('check', {});
    await vi.waitFor(async () => expect(await count('failed')).toBe(1), { timeout: 8000 });

    expect(calls).toBe(3);
    const [failed] = await queue.getFailed();
    expect(failed.attemptsMade).toBe(3);
  });

  it('does not retry an UnrecoverableError', async () => {
    setup({ attempts: 3, backoffMs: 20 });
    let calls = 0;
    startWorker(async () => {
      calls++;
      throw new UnrecoverableError('bad payload');
    });

    await queue.add('check', {});
    await vi.waitFor(async () => expect(await count('failed')).toBe(1), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 300)); // a retry would show up by now
    expect(calls).toBe(1);
  });

  it('attempts: 1 means no retry at all', async () => {
    setup({ attempts: 1, backoffMs: 20 });
    let calls = 0;
    startWorker(async () => {
      calls++;
      throw new Error('boom');
    });

    await queue.add('check', {});
    await vi.waitFor(async () => expect(await count('failed')).toBe(1), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toBe(1);
  });
});