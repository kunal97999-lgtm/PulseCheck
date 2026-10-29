import { describe, it, expect } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { openIncident, resolveOpenIncident } from '../../src/modules/incidents/incidents.repository.js';
import { recordCheckResult } from '../../src/modules/checks/checkResults.service.js';
import { pauseMonitor } from '../../src/modules/monitors/monitors.service.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

const T = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
const PARALLEL = 10; // equals the pool size, so every call really runs at once

async function makeMonitor(over = {}) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ('conc@example.com', 'x') RETURNING id`,
  );
  const { rows: [m] } = await pool.query(
    `INSERT INTO monitors (user_id, name, url, consecutive_failures, failure_streak_started_at)
     VALUES ($1, 'm', 'https://example.com/', $2::int, $3::timestamptz) RETURNING id`,
    [u.id, over.failures ?? 0, over.streak ?? null],
  );
  return { userId: u.id, monitorId: m.id };
}
const incidentRows = async (id) =>
  (await pool.query('SELECT * FROM incidents WHERE monitor_id = $1', [id])).rows;
const fail = (sec) => ({
  checkedAt: T(sec), success: false, statusCode: null, latencyMs: 10,
  errorType: 'timeout', errorMessage: 'Request timed out',
});

describe('the database alone prevents duplicate open incidents (NO monitor lock involved)', () => {
  it('10 parallel openIncident calls: exactly one gets an id, the rest get null', async () => {
    const { monitorId } = await makeMonitor();
    const args = {
      monitorId, firstFailedAt: T(0), startedAt: T(1),
      failureType: 'timeout', failureReason: 'Request timed out',
    };
    const ids = await Promise.all(Array.from({ length: PARALLEL }, () => openIncident(args, pool)));

    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect(await incidentRows(monitorId)).toHaveLength(1);
  });

  it('raw parallel INSERTs (no ON CONFLICT): one wins, the rest hit the unique index', async () => {
    const { monitorId } = await makeMonitor();
    const attempts = await Promise.allSettled(
      Array.from({ length: PARALLEL }, () =>
        pool.query(
          `INSERT INTO incidents (monitor_id, first_failed_at, started_at) VALUES ($1, now(), now())`,
          [monitorId],
        ),
      ),
    );
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(PARALLEL - 1);
    expect(rejected.every((r) => r.reason.code === '23505')).toBe(true);
    expect(await incidentRows(monitorId)).toHaveLength(1);
  });

  it('10 parallel resolves: exactly one resolves, the rest find nothing open', async () => {
    const { monitorId } = await makeMonitor();
    await pool.query(
      `INSERT INTO incidents (monitor_id, first_failed_at, started_at) VALUES ($1, now(), now())`,
      [monitorId],
    );
    const ids = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        resolveOpenIncident(monitorId, { reason: 'recovered' }, pool),
      ),
    );
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect((await incidentRows(monitorId))[0]).toMatchObject({ status: 'resolved' });
  });
});

describe('through the service', () => {
  it('5 simultaneous failing results (3rd failure crosses the threshold): one incident', async () => {
    const { monitorId } = await makeMonitor({ failures: 2, streak: T(0) });
    const outs = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        recordCheckResult({ monitorId, scheduledFor: T(i * 60), result: fail(i * 60 + 1) }),
      ),
    );

    expect(outs.every((o) => o.status === 'recorded')).toBe(true);
    const rows = await incidentRows(monitorId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    const m = (await pool.query('SELECT current_status FROM monitors WHERE id = $1', [monitorId])).rows[0];
    expect(m.current_status).toBe('down');
    const n = (await pool.query('SELECT count(*)::int AS n FROM check_results WHERE monitor_id = $1', [monitorId])).rows[0].n;
    expect(n).toBe(5); // all stored, even if some were too old to move current state
  });

  it('a pause racing a threshold-crossing result never leaves an open incident on a paused monitor', async () => {
    const { userId, monitorId } = await makeMonitor({ failures: 2, streak: T(0) });

    for (let i = 0; i < 15; i++) {
      await pool.query('DELETE FROM incidents WHERE monitor_id = $1', [monitorId]);
      await pool.query('DELETE FROM check_results WHERE monitor_id = $1', [monitorId]);
      await pool.query(
        `UPDATE monitors SET is_active = true, current_status = 'pending', consecutive_failures = 2,
                consecutive_successes = 0, failure_streak_started_at = $2::timestamptz,
                last_checked_at = NULL, next_check_at = now()
          WHERE id = $1::uuid`,
        [monitorId, T(0)],
      );

      // Start both at the same moment. Either commit order must leave a consistent world.
      const [recorded] = await Promise.all([
        recordCheckResult({ monitorId, scheduledFor: T(120), result: fail(121) }),
        pauseMonitor(userId, monitorId),
      ]);

      expect(['recorded', 'skipped_inactive']).toContain(recorded.status);
      const m = (await pool.query('SELECT is_active FROM monitors WHERE id = $1', [monitorId])).rows[0];
      expect(m.is_active).toBe(false);
      const open = (await incidentRows(monitorId)).filter((r) => r.status === 'open');
      expect(open).toHaveLength(0);
    }
  }, 30000);
});