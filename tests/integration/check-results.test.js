import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { recordCheckResult } from '../../src/modules/checks/checkResults.service.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();
const app = createApp();

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const at = (sec) => new Date(T0 + sec * 1000);

const ok = (sec, over = {}) => ({
  checkedAt: at(sec), success: true, statusCode: 200, latencyMs: 42,
  errorType: null, errorMessage: null, ...over,
});
const fail = (sec, over = {}) => ({
  checkedAt: at(sec), success: false, statusCode: 503, latencyMs: 80,
  errorType: 'http_status', errorMessage: 'Unexpected status code 503 (expected 200-299)', ...over,
});

async function newMonitor() {
  const { token } = await registerAndLogin(app);
  const res = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'm', url: 'https://api.example.com/health' })
    .expect(201);
  return res.body.data.monitor.id;
}
const record = (monitorId, slotSec, result) =>
  recordCheckResult({ monitorId, scheduledFor: at(slotSec), result });
const monitorRow = async (id) =>
  (await pool.query('SELECT * FROM monitors WHERE id = $1', [id])).rows[0];
const resultRows = async (id) =>
  (await pool.query('SELECT * FROM check_results WHERE monitor_id = $1 ORDER BY scheduled_for', [id])).rows;

describe('recording results', () => {
  it('stores a success and moves the monitor to up', async () => {
    const id = await newMonitor();
    const out = await record(id, 0, ok(1));
    expect(out).toMatchObject({ status: 'recorded', stateApplied: true });

    const [row] = await resultRows(id);
    expect(row).toMatchObject({
      success: true, status_code: 200, latency_ms: 42, error_type: null, error_message: null,
    });
    expect(row.scheduled_for).toEqual(at(0));
    expect(row.checked_at).toEqual(at(1));

    const m = await monitorRow(id);
    expect(m).toMatchObject({ current_status: 'up', consecutive_failures: 0, consecutive_successes: 1 });
    expect(m.last_checked_at).toEqual(at(1));
  });

  it('stores failure details, and goes down only at the threshold (3)', async () => {
    const id = await newMonitor();
    await record(id, 0, fail(1));
    await record(id, 60, fail(61));
    let m = await monitorRow(id);
    expect(m).toMatchObject({ current_status: 'pending', consecutive_failures: 2 });

    await record(id, 120, fail(121));
    m = await monitorRow(id);
    expect(m).toMatchObject({ current_status: 'down', consecutive_failures: 3 });

    const rows = await resultRows(id);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ success: false, status_code: 503, error_type: 'http_status' });
  });

  it('stores failures that have no status code or latency', async () => {
    const id = await newMonitor();
    await record(id, 0, fail(1, {
      statusCode: null, latencyMs: null, errorType: 'blocked',
      errorMessage: 'Target is not permitted by security policy',
    }));
    const [row] = await resultRows(id);
    expect(row).toMatchObject({ status_code: null, latency_ms: null, error_type: 'blocked' });
  });

  it('recovers after a success and resets the failure counter', async () => {
    const id = await newMonitor();
    for (let i = 0; i < 3; i++) await record(id, i * 60, fail(i * 60 + 1));
    await record(id, 180, ok(181));
    expect(await monitorRow(id)).toMatchObject({
      current_status: 'up', consecutive_failures: 0, consecutive_successes: 1,
    });
  });

  it('does not change updated_at (that column means "configuration changed")', async () => {
    const id = await newMonitor();
    const before = (await monitorRow(id)).updated_at;
    await record(id, 0, ok(1));
    expect((await monitorRow(id)).updated_at).toEqual(before);
  });
});

describe('idempotency', () => {
  it('a duplicate slot is a no-op: one row, counters not incremented twice', async () => {
    const id = await newMonitor();
    const first = await record(id, 0, fail(1));
    const again = await record(id, 0, fail(2)); // same slot, even with a later checked_at
    const third = await record(id, 0, fail(3));

    expect(first.status).toBe('recorded');
    expect(again).toEqual({ status: 'duplicate' });
    expect(third).toEqual({ status: 'duplicate' });
    expect(await resultRows(id)).toHaveLength(1);
    expect((await monitorRow(id)).consecutive_failures).toBe(1);
  });

  it('five concurrent deliveries of the same job record exactly one result', async () => {
    const id = await newMonitor();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => record(id, 0, fail(1))),
    );
    expect(outcomes.filter((o) => o.status === 'recorded')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'duplicate')).toHaveLength(4);
    expect(await resultRows(id)).toHaveLength(1);
    expect((await monitorRow(id)).consecutive_failures).toBe(1);
  });

  it('different slots are all recorded', async () => {
    const id = await newMonitor();
    await record(id, 0, ok(1));
    await record(id, 60, ok(61));
    expect(await resultRows(id)).toHaveLength(2);
    expect((await monitorRow(id)).consecutive_successes).toBe(2);
  });

  it('the same slot on different monitors does not collide', async () => {
    const a = await newMonitor();
    const { token } = await registerAndLogin(app, 'bob@example.com');
    const b = (await request(app).post('/api/monitors').set('Authorization', `Bearer ${token}`)
      .send({ name: 'b', url: 'https://b.example.com/' }).expect(201)).body.data.monitor.id;

    expect((await record(a, 0, ok(1))).status).toBe('recorded');
    expect((await record(b, 0, ok(1))).status).toBe('recorded');
  });
});

describe('out-of-order results', () => {
  it('stores a stale result but does not let it overwrite newer state', async () => {
    const id = await newMonitor();
    await record(id, 60, ok(70)); // newer result arrives first
    const late = await record(id, 0, fail(10)); // older result arrives late

    expect(late).toEqual({ status: 'recorded', stateApplied: false });
    expect(await resultRows(id)).toHaveLength(2); // history is complete
    const m = await monitorRow(id);
    expect(m).toMatchObject({ current_status: 'up', consecutive_failures: 0 });
    expect(m.last_checked_at).toEqual(at(70));
  });
});

describe('deleted monitors', () => {
  it('returns monitor_missing and stores nothing when the monitor was deleted mid-check', async () => {
    const id = await newMonitor();
    await pool.query('DELETE FROM monitors WHERE id = $1', [id]);
    expect(await record(id, 0, ok(1))).toEqual({ status: 'monitor_missing' });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM check_results');
    expect(rows[0].n).toBe(0);
  });

  it('deleting a monitor deletes its results (ON DELETE CASCADE)', async () => {
    const id = await newMonitor();
    await record(id, 0, ok(1));
    await pool.query('DELETE FROM monitors WHERE id = $1', [id]);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM check_results');
    expect(rows[0].n).toBe(0);
  });
});

describe('database-level guarantees (bypassing the service)', () => {
  const insert = (id, cols) =>
    pool.query(
      `INSERT INTO check_results (monitor_id, scheduled_for, checked_at, success, status_code, latency_ms, error_type)
       VALUES ($1, now(), now(), $2, $3, $4, $5)`,
      [id, ...cols],
    );

  it('rejects a duplicate slot even with raw SQL', async () => {
    const id = await newMonitor();
    const raw = () =>
      pool.query(
        `INSERT INTO check_results (monitor_id, scheduled_for, checked_at, success)
         VALUES ($1, $2, now(), true)`,
        [id, at(0)],
      );
    await raw();
    await expect(raw()).rejects.toMatchObject({ code: '23505', constraint: 'check_results_slot_unique' });
  });

  it.each([
    ['success with an error type', [true, 200, 10, 'timeout'], 'check_results_consistent'],
    ['failure without an error type', [false, 500, 10, null], 'check_results_consistent'],
    ['unknown error type', [false, null, 10, 'weird'], 'check_results_error_type'],
    ['negative latency', [true, 200, -1, null], 'check_results_latency'],
    ['status code out of range', [true, 99, 10, null], 'check_results_status_code'],
  ])('rejects: %s', async (_n, cols, constraint) => {
    const id = await newMonitor();
    await expect(insert(id, cols)).rejects.toMatchObject({ code: '23514', constraint });
  });

  it('rejects a result for a monitor that does not exist (foreign key)', async () => {
    await expect(
      insert('00000000-0000-4000-8000-000000000000', [true, 200, 10, null]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});