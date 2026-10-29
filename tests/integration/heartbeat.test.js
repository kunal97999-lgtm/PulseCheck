import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRedisConnection } from '../../src/queues/connection.js';
import {
  startHeartbeat, countLiveWorkers, recordBeat, heartbeatKey,
} from '../../src/workers/heartbeat.js';

let redis;
let prefix;
function setup() {
  redis = createRedisConnection();
  prefix = `test-${randomUUID()}`;
}
afterEach(async () => {
  await redis.del(heartbeatKey(prefix)).catch(() => {});
  await redis.quit().catch(() => {});
});
const live = (staleMs = 30_000) => countLiveWorkers(redis, prefix, { staleMs });

describe('heartbeat', () => {
  it('a started worker is counted live, and a stopped one disappears immediately', async () => {
    setup();
    const hb = startHeartbeat({ redis, prefix, workerId: 'w1', intervalMs: 1000 });
    await vi.waitFor(async () => expect(await live()).toBe(1), { timeout: 3000 });

    await hb.stop();
    expect(await live()).toBe(0);
  });

  it('counts several workers separately', async () => {
    setup();
    await recordBeat(redis, prefix, 'a');
    await recordBeat(redis, prefix, 'b');
    await recordBeat(redis, prefix, 'c');
    expect(await live()).toBe(3);
  });

  it('a worker that stopped beating (crashed) falls out after the stale window', async () => {
    setup();
    const now = Date.now();
    await recordBeat(redis, prefix, 'dead', now - 60_000);
    await recordBeat(redis, prefix, 'alive', now);
    expect(await countLiveWorkers(redis, prefix, { now, staleMs: 30_000 })).toBe(1);
  });

  it('entries silent for over an hour are pruned from the set', async () => {
    setup();
    const now = Date.now();
    await redis.zadd(heartbeatKey(prefix), now - 2 * 3_600_000, 'ancient');
    await recordBeat(redis, prefix, 'fresh', now);
    expect(await redis.zcard(heartbeatKey(prefix))).toBe(1);
  });

  it('keeps beating on its interval', async () => {
    setup();
    const hb = startHeartbeat({ redis, prefix, workerId: 'w1', intervalMs: 50 });
    await vi.waitFor(async () => expect(await redis.zscore(heartbeatKey(prefix), 'w1')).toBeTruthy(), { timeout: 2000 });
    const first = Number(await redis.zscore(heartbeatKey(prefix), 'w1'));
    await vi.waitFor(async () => expect(Number(await redis.zscore(heartbeatKey(prefix), 'w1'))).toBeGreaterThan(first), { timeout: 2000 });
    await hb.stop();
  });

  it('survives Redis errors: nothing thrown, keeps trying, stop() still resolves', async () => {
    setup();
    const broken = {
      zadd: vi.fn().mockRejectedValue(new Error('redis down')),
      zremrangebyscore: vi.fn().mockResolvedValue(0),
      zrem: vi.fn().mockRejectedValue(new Error('redis down')),
    };
    const hb = startHeartbeat({ redis: broken, prefix, workerId: 'w1', intervalMs: 20 });
    await vi.waitFor(() => expect(broken.zadd.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    await expect(hb.stop()).resolves.toBeUndefined();
  });
});