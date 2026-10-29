import { describe, it, expect, vi } from 'vitest';
import { pool } from '../../src/db/pool.js';
import {
  purgeCheckResults, purgeExpiredSessions, purgeResolvedIncidents, runRetention,
} from '../../src/modules/retention/retention.js';
import { startRetentionLoop } from '../../src/scheduler/retentionLoop.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

const NOW = new Date('2026-06-01T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (d) => new Date(NOW.getTime() - d * DAY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const opts = (over = {}) => ({ retentionDays: 35, now: NOW, batchSize: 1000, maxBatches: 100, ...over });

let n = 0;
async function makeMonitor() {
  n++;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`r${n}@example.com`]);
  const { rows: [m] } = await pool.query(
    `INSERT INTO monitors (user_id, name, url, is_active) VALUES ($1, 'm', 'https://example.com/', false) RETURNING id`, [u.id]);
  return { monitorId: m.id, userId: u.id };
}
// `times` are Date objects; scheduled_for = checked_at, distinct per row.
async function addChecks(monitorId, times) {
  await pool.query(
    `INSERT INTO check_results (monitor_id, scheduled_for, checked_at, success, status_code, latency_ms)
     SELECT $1::uuid, t, t, true, 200, 100 FROM unnest($2::timestamptz[]) AS t`,
    [monitorId, times],
  );
}
const manyOld = (count, startDays = 40) =>
  Array.from({ length: count }, (_, k) => new Date(daysAgo(startDays).getTime() - k * 1000));
const count = async (table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

describe('purgeCheckResults', () => {
  it('deletes only rows older than the cutoff, across monitors', async () => {
    const a = await makeMonitor();
    const b = await makeMonitor();
    await addChecks(a.monitorId, [daysAgo(40), daysAgo(36), daysAgo(35.5), daysAgo(10), daysAgo(1)]);
    await addChecks(b.monitorId, [daysAgo(50), daysAgo(2)]);

    expect(await purgeCheckResults(opts())).toEqual({ deleted: 4, complete: true });
    expect(await count('check_results')).toBe(3);
    const { rows } = await pool.query('SELECT checked_at FROM check_results');
    expect(rows.every((r) => r.checked_at >= daysAgo(35))).toBe(true);
  });

  it('keeps a row exactly at the cutoff and deletes one millisecond older', async () => {
    const { monitorId } = await makeMonitor();
    const cutoff = daysAgo(35);
    await addChecks(monitorId, [cutoff, new Date(cutoff.getTime() - 1)]);
    expect((await purgeCheckResults(opts())).deleted).toBe(1);
    const { rows } = await pool.query('SELECT checked_at FROM check_results');
    expect(rows).toEqual([{ checked_at: cutoff }]);
  });

  it('works through many batches', async () => {
    const { monitorId } = await makeMonitor();
    await addChecks(monitorId, manyOld(55));
    expect(await purgeCheckResults(opts({ batchSize: 10 }))).toEqual({ deleted: 55, complete: true });
    expect(await count('check_results')).toBe(0);
  });

  it('stops at the batch budget, reports incomplete, and a later run finishes the job', async () => {
    const { monitorId } = await makeMonitor();
    await addChecks(monitorId, manyOld(55));

    expect(await purgeCheckResults(opts({ batchSize: 10, maxBatches: 2 }))).toEqual({ deleted: 20, complete: false });
    expect(await count('check_results')).toBe(35);
    expect(await purgeCheckResults(opts({ batchSize: 10, maxBatches: 100 }))).toEqual({ deleted: 35, complete: true });
  });

  it('monitors with nothing to delete do not consume the batch budget', async () => {
    for (let i = 0; i < 5; i++) await makeMonitor(); // empty
    const busy = await makeMonitor();
    await addChecks(busy.monitorId, manyOld(30));
    const r = await purgeCheckResults(opts({ batchSize: 10, maxBatches: 3 }));
    expect(r.deleted).toBe(30); // nothing was starved, whatever order the monitors came in
  });

  it('is idempotent: a second run deletes nothing', async () => {
    const { monitorId } = await makeMonitor();
    await addChecks(monitorId, manyOld(5));
    await purgeCheckResults(opts());
    expect(await purgeCheckResults(opts())).toEqual({ deleted: 0, complete: true });
  });

  it('two concurrent purges delete every row exactly once, with no errors', async () => {
    const { monitorId } = await makeMonitor();
    await addChecks(monitorId, manyOld(200));
    const [x, y] = await Promise.all([
      purgeCheckResults(opts({ batchSize: 20 })),
      purgeCheckResults(opts({ batchSize: 20 })),
    ]);
    expect(x.deleted + y.deleted).toBe(200);
    expect(await count('check_results')).toBe(0);
  });

  it('touches nothing but old check_results', async () => {
    const { monitorId } = await makeMonitor();
    await addChecks(monitorId, [daysAgo(50)]);
    await purgeCheckResults(opts());
    expect(await count('monitors')).toBe(1);
    expect(await count('users')).toBe(1);
  });
});

describe('purgeExpiredSessions', () => {
  it('deletes expired sessions and keeps valid ones', async () => {
    const { userId } = await makeMonitor();
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES
         ($1, 'h1', $2), ($1, 'h2', $2), ($1, 'h3', $3)`,
      [userId, daysAgo(1), new Date(NOW.getTime() + DAY)],
    );
    expect(await purgeExpiredSessions({ now: NOW, batchSize: 100, maxBatches: 10 })).toEqual({ deleted: 2, complete: true });
    const { rows } = await pool.query('SELECT token_hash FROM sessions');
    expect(rows).toEqual([{ token_hash: 'h3' }]);
  });
});

describe('purgeResolvedIncidents', () => {
  it('deletes old RESOLVED incidents (and their deliveries); keeps recent and open ones', async () => {
    const { monitorId } = await makeMonitor();
    const ins = async (status, startedDaysAgo, resolvedDaysAgo) => {
      const { rows: [i] } = await pool.query(
        `INSERT INTO incidents (monitor_id, status, first_failed_at, started_at, resolved_at, resolution_reason)
         VALUES ($1, $2::text, $3, $3, $4, $5::text) RETURNING id`,
        [monitorId, status, daysAgo(startedDaysAgo),
         resolvedDaysAgo === null ? null : daysAgo(resolvedDaysAgo), status === 'resolved' ? 'recovered' : null]);
      return i.id;
    };
    const old = await ins('resolved', 101, 100);
    await ins('resolved', 11, 10);
    await ins('open', 200, null); // open for ages: must never be purged
    await pool.query(`INSERT INTO notification_deliveries (incident_id, event_type) VALUES ($1, 'incident_opened')`, [old]);

    expect(await purgeResolvedIncidents({ ...opts({ retentionDays: 90 }) })).toEqual({ deleted: 1, complete: true });
    expect(await count('incidents')).toBe(2);
    expect(await count('notification_deliveries')).toBe(0); // cascaded
    const { rows } = await pool.query(`SELECT status FROM incidents ORDER BY status`);
    expect(rows.map((r) => r.status)).toEqual(['open', 'resolved']);
  });
});

describe('runRetention', () => {
  const config = { checkRetentionDays: 35, incidentRetentionDays: 90, batchSize: 100, maxBatches: 10 };

  it('returns a summary for each task', async () => {
    const { monitorId } = await makeMonitor();
    await addChecks(monitorId, [daysAgo(40), daysAgo(1)]);
    const s = await runRetention(config, { now: NOW });
    expect(s.checks).toEqual({ deleted: 1, complete: true });
    expect(s.sessions).toEqual({ deleted: 0, complete: true });
    expect(s.incidents).toEqual({ deleted: 0, complete: true });
  });

  it('one failing task does not stop the others', async () => {
    const { monitorId } = await makeMonitor();
    await addChecks(monitorId, [daysAgo(40)]);
    const db = {
      query: (sql, params) =>
        sql.includes('FROM sessions') ? Promise.reject(new Error('boom')) : pool.query(sql, params),
    };
    const s = await runRetention(config, { now: NOW, db });
    expect(s.sessions).toEqual({ error: true });
    expect(s.checks.deleted).toBe(1);
    expect(s.incidents.complete).toBe(true);
  });
});

describe('startRetentionLoop', () => {
  it('keeps running after an error, and stops cleanly', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({});
    const loop = startRetentionLoop({ intervalMs: 20, run });
    await vi.waitFor(() => expect(run.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 3000 });

    await loop.stop();
    const calls = run.mock.calls.length;
    await sleep(100);
    expect(run.mock.calls.length).toBe(calls);
  });
});