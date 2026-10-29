import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../../src/db/pool.js';
import { createRedisConnection } from '../../src/queues/connection.js';
import { createCheckQueue } from '../../src/queues/checkQueue.js';
import { createNotificationQueue } from '../../src/queues/notificationQueue.js';
import { recordBeat, heartbeatKey } from '../../src/workers/heartbeat.js';
import { collectStatus } from '../../src/modules/ops/ops.service.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

const config = { overdueSeconds: 300, notificationLagSeconds: 900, workerStaleSeconds: 30 };
let cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
  cleanups = [];
});

function setup() {
  const prefix = `test-${randomUUID()}`;
  const redis = createRedisConnection();
  const queues = {
    checks: createCheckQueue({ connection: redis, prefix }),
    notifications: createNotificationQueue({ connection: redis, prefix }),
  };
  cleanups.push(
    () => redis.del(heartbeatKey(prefix)),
    () => queues.checks.obliterate({ force: true }),
    () => queues.notifications.obliterate({ force: true }),
    () => queues.checks.close(),
    () => queues.notifications.close(),
    () => redis.quit(),
  );
  const collect = (over = {}) => collectStatus({ redis, queues, prefix, config, ...over });
  return { redis, queues, prefix, collect };
}

let n = 0;
async function makeMonitor({ active = true, dueOffsetSec = 3600, email, name = 'm', url = 'https://example.com/' } = {}) {
  n++;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [email ?? `o${n}@example.com`]);
  const { rows: [m] } = await pool.query(
    `INSERT INTO monitors (user_id, name, url, is_active, next_check_at)
     VALUES ($1, $2, $3, $4::boolean,
             CASE WHEN $4::boolean THEN now() + ($5::int * interval '1 second') END)
     RETURNING id`,
    [u.id, name, url, active, dueOffsetSec]);
  return m.id;
}

describe('collectStatus', () => {
  it('an empty system with a live worker is ok', async () => {
    const { redis, prefix, collect } = setup();
    await recordBeat(redis, prefix, 'w1');
    const s = await collect();
    expect(s).toMatchObject({
      status: 'ok', reasons: [], workers: { live: 1 },
      scheduler: { overdueMonitors: 0, oldestOverdueSeconds: 0, thresholdSeconds: 300 },
      notifications: { pending: 0, oldestPendingSeconds: 0 },
    });
  });

  it('no live workers: down', async () => {
    const { collect } = setup();
    expect(await collect()).toMatchObject({ status: 'down', reasons: ['no_live_workers'], workers: { live: 0 } });
  });

  it('a stale heartbeat does not count as live', async () => {
    const { redis, prefix, collect } = setup();
    await recordBeat(redis, prefix, 'w1', Date.now() - 120_000);
    expect((await collect()).status).toBe('down');
  });

  it('counts only ACTIVE monitors overdue beyond the threshold', async () => {
    const { redis, prefix, collect } = setup();
    await recordBeat(redis, prefix, 'w1');
    await makeMonitor({ dueOffsetSec: -600 }); // 10 min overdue: counted
    await makeMonitor({ dueOffsetSec: -60 }); // 1 min overdue: within the threshold
    await makeMonitor({ dueOffsetSec: 300 }); // not due yet
    await makeMonitor({ active: false }); // paused: never counted

    const s = await collect();
    expect(s.scheduler.overdueMonitors).toBe(1);
    expect(s.scheduler.oldestOverdueSeconds).toBeGreaterThanOrEqual(599);
    expect(s).toMatchObject({ status: 'degraded', reasons: ['scheduler_lagging'] });
  });

  it('overdue monitors AND no workers: down (the pipeline is not running)', async () => {
    const { collect } = setup();
    await makeMonitor({ dueOffsetSec: -600 });
    const s = await collect();
    expect(s).toMatchObject({ status: 'down', reasons: ['no_live_workers'] });
    expect(s.scheduler.overdueMonitors).toBe(1); // still reported in the numbers
  });

  it('an old pending notification degrades; an old SENT one does not', async () => {
    const { redis, prefix, collect } = setup();
    await recordBeat(redis, prefix, 'w1');
    const monitorId = await makeMonitor();
    const insert = async (status) => {
      const { rows: [i] } = await pool.query(
        `INSERT INTO incidents (monitor_id, status, first_failed_at, started_at, resolved_at, resolution_reason)
         VALUES ($1, $2::text, now() - interval '2 hours', now() - interval '2 hours',
                 CASE WHEN $2::text = 'resolved' THEN now() - interval '1 hour' END,
                 CASE WHEN $2::text = 'resolved' THEN 'recovered' END) RETURNING id`,
        [monitorId, status]);
      return i.id;
    };
    const old = new Date(Date.now() - 20 * 60_000);
    const sent = await insert('resolved');
    await pool.query(
      `INSERT INTO notification_deliveries (incident_id, event_type, status, sent_at, created_at)
       VALUES ($1, 'incident_opened', 'sent', now(), $2)`, [sent, old]);
    expect((await collect()).status).toBe('ok');

    const pending = await insert('open');
    await pool.query(
      `INSERT INTO notification_deliveries (incident_id, event_type, status, created_at)
       VALUES ($1, 'incident_opened', 'pending', $2)`, [pending, old]);
    const s = await collect();
    expect(s).toMatchObject({ status: 'degraded', reasons: ['notifications_lagging'], notifications: { pending: 1 } });
    expect(s.notifications.oldestPendingSeconds).toBeGreaterThanOrEqual(1199);
  });

  it('reports queue depth', async () => {
    const { redis, prefix, queues, collect } = setup();
    await recordBeat(redis, prefix, 'w1');
    for (let i = 0; i < 3; i++) await queues.checks.add('check', { i });
    const s = await collect();
    expect(s.queues.checks.waiting).toBe(3);
    expect(s.queues.notifications.waiting).toBe(0);
  });

  it('Redis unavailable: down with a reason, nulls for Redis data, database data still reported', async () => {
    const { queues } = setup();
    const brokenRedis = { zcount: async () => { throw new Error('redis down 10.0.0.9'); } };
    const brokenQueues = { checks: { getJobCounts: async () => { throw new Error('x'); } }, notifications: queues.notifications };
    const s = await collect2({ redis: brokenRedis, queues: brokenQueues });
    expect(s).toMatchObject({ status: 'down', workers: { live: null }, queues: { checks: null } });
    expect(s.reasons).toContain('redis_unavailable');
    expect(s.scheduler).not.toBeNull();
    expect(JSON.stringify(s)).not.toMatch(/10\.0\.0\.9|redis down/); // errors are never echoed
  });

  it('Postgres unavailable: down with a reason', async () => {
    const { redis, prefix, queues } = setup();
    await recordBeat(redis, prefix, 'w1');
    const { default: pg } = await import('pg');
    const dead = new pg.Pool({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    cleanups.push(() => dead.end());
    // Swap the pool's query for the duration: ops.queries uses the shared pool by default.
    const { vi } = await import('vitest');
    const spy = vi.spyOn(pool, 'query').mockRejectedValue(new Error('connect ECONNREFUSED 10.1.1.1:5432'));
    try {
      const s = await collectStatus({ redis, queues, prefix, config });
      expect(s).toMatchObject({ status: 'down', scheduler: null, notifications: null });
      expect(s.reasons).toContain('database_unavailable');
      expect(JSON.stringify(s)).not.toMatch(/10\.1\.1\.1|ECONNREFUSED/);
    } finally {
      spy.mockRestore();
    }
  });

  it('exposes counts and ages only: no emails, monitor names, or URLs', async () => {
    const { redis, prefix, collect } = setup();
    await recordBeat(redis, prefix, 'w1');
    await makeMonitor({
      email: 'secret-owner@example.com', name: 'SecretMonitorName',
      url: 'https://secret-host.example.com/private/path', dueOffsetSec: -900,
    });
    const body = JSON.stringify(await collect());
    expect(body).not.toMatch(/secret|owner@|private|example\.com/i);
  });
});

// helper used by the Redis-failure test above
function collect2({ redis, queues }) {
  return collectStatus({ redis, queues, prefix: 'unused', config });
}