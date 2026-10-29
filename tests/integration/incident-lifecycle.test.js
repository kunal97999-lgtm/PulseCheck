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
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const ok = (sec) => ({
  checkedAt: at(sec), success: true, statusCode: 200, latencyMs: 40, errorType: null, errorMessage: null,
});
const fail = (sec, over = {}) => ({
  checkedAt: at(sec), success: false, statusCode: null, latencyMs: 100,
  errorType: 'timeout', errorMessage: 'Request timed out', ...over,
});

async function newMonitor() {
  const { token } = await registerAndLogin(app);
  const res = await request(app)
    .post('/api/monitors')
    .set(bearer(token))
    .send({ name: 'm', url: 'https://api.example.com/health' })
    .expect(201);
  return { id: res.body.data.monitor.id, token };
}
const record = (id, slotSec, result) =>
  recordCheckResult({ monitorId: id, scheduledFor: at(slotSec), result });
const incidents = async (id) =>
  (await pool.query('SELECT * FROM incidents WHERE monitor_id = $1 ORDER BY started_at', [id])).rows;
const monitorRow = async (id) =>
  (await pool.query('SELECT * FROM monitors WHERE id = $1', [id])).rows[0];
const failN = async (id, n, startSlot = 0) => {
  const outs = [];
  for (let i = 0; i < n; i++) outs.push(await record(id, startSlot + i * 60, fail(startSlot + i * 60 + 1)));
  return outs;
};

describe('opening', () => {
  it('opens exactly when the failure threshold (3) is reached, with the right facts', async () => {
    const { id } = await newMonitor();
    const outs = await failN(id, 2);
    expect(outs.every((o) => o.incident === null)).toBe(true);
    expect(await incidents(id)).toHaveLength(0);

    const third = await record(id, 120, fail(121));
    expect(third.incident).toMatchObject({ action: 'opened' });

    const [inc] = await incidents(id);
    expect(inc).toMatchObject({
      status: 'open', failure_type: 'timeout', failure_reason: 'Request timed out',
      resolved_at: null, resolution_reason: null,
    });
    expect(inc.first_failed_at).toEqual(at(1)); // when the streak began
    expect(inc.started_at).toEqual(at(121)); // when the threshold was crossed
  });

  it('failure_threshold 1 opens on the first failure (first_failed_at == started_at)', async () => {
    const { id } = await newMonitor();
    await pool.query('UPDATE monitors SET failure_threshold = 1 WHERE id = $1', [id]);
    await record(id, 0, fail(1));
    const [inc] = await incidents(id);
    expect(inc.first_failed_at).toEqual(inc.started_at);
  });

  it('keeps ONE incident while failures continue', async () => {
    const { id } = await newMonitor();
    await failN(id, 8);
    const rows = await incidents(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
  });

  it('failures that never reach the threshold open nothing (flicker)', async () => {
    const { id } = await newMonitor();
    await record(id, 0, fail(1));
    await record(id, 60, fail(61));
    await record(id, 120, ok(121));
    await record(id, 180, fail(181));
    await record(id, 240, fail(241));
    expect(await incidents(id)).toHaveLength(0);
  });

  it('a blocked target opens an incident (documented behavior)', async () => {
    const { id } = await newMonitor();
    await pool.query('UPDATE monitors SET failure_threshold = 1 WHERE id = $1', [id]);
    await record(id, 0, fail(1, {
      errorType: 'blocked', errorMessage: 'Target is not permitted by security policy', latencyMs: null,
    }));
    expect((await incidents(id))[0]).toMatchObject({ failure_type: 'blocked' });
  });
});

describe('resolving', () => {
  it('resolves on recovery with the recovering check as resolved_at', async () => {
    const { id } = await newMonitor();
    await failN(id, 3);
    const out = await record(id, 180, ok(181));
    expect(out.incident).toMatchObject({ action: 'resolved' });

    const [inc] = await incidents(id);
    expect(inc).toMatchObject({ status: 'resolved', resolution_reason: 'recovered' });
    expect(inc.resolved_at).toEqual(at(181));
    expect(await monitorRow(id)).toMatchObject({ current_status: 'up', failure_streak_started_at: null });
  });

  it('honors recovery_threshold 2: one success is not enough', async () => {
    const { id } = await newMonitor();
    await pool.query('UPDATE monitors SET recovery_threshold = 2 WHERE id = $1', [id]);
    await failN(id, 3);

    await record(id, 180, ok(181));
    expect((await incidents(id))[0].status).toBe('open');

    await record(id, 240, ok(241));
    expect((await incidents(id))[0].status).toBe('resolved');
  });

  it('a new outage after recovery opens a NEW incident', async () => {
    const { id } = await newMonitor();
    await failN(id, 3);
    await record(id, 180, ok(181));
    await failN(id, 3, 240);

    const rows = await incidents(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(['resolved', 'open']);
  });
});

describe('retries and ordering cannot corrupt incidents', () => {
  it('a duplicate delivery of the threshold-crossing check opens nothing extra', async () => {
    const { id } = await newMonitor();
    await failN(id, 2);
    const first = await record(id, 120, fail(121));
    const again = await record(id, 120, fail(122));

    expect(first.incident).toMatchObject({ action: 'opened' });
    expect(again).toEqual({ status: 'duplicate' });
    expect(await incidents(id)).toHaveLength(1);
  });

  it('a late, older failure is stored but cannot open an incident', async () => {
    const { id } = await newMonitor();
    await record(id, 0, fail(1));
    await record(id, 60, fail(61)); // 2 failures, threshold 3
    const late = await record(id, 120, fail(30)); // older checked_at, arrives last

    expect(late).toEqual({ status: 'recorded', stateApplied: false });
    expect(await incidents(id)).toHaveLength(0);
    expect(await monitorRow(id)).toMatchObject({ current_status: 'pending', consecutive_failures: 2 });
  });
});

describe('pause, resume, and reconfiguration', () => {
  it('pausing resolves the open incident as monitor_paused', async () => {
    const { id, token } = await newMonitor();
    await failN(id, 3);
    await request(app).post(`/api/monitors/${id}/pause`).set(bearer(token)).expect(200);

    const [inc] = await incidents(id);
    expect(inc).toMatchObject({ status: 'resolved', resolution_reason: 'monitor_paused' });
    expect(inc.resolved_at >= inc.started_at).toBe(true);
  });

  it('pausing a healthy monitor, twice, creates nothing and does not fail', async () => {
    const { id, token } = await newMonitor();
    await request(app).post(`/api/monitors/${id}/pause`).set(bearer(token)).expect(200);
    await request(app).post(`/api/monitors/${id}/pause`).set(bearer(token)).expect(200);
    expect(await incidents(id)).toHaveLength(0);
  });

  it('resuming starts clean: pending, no streak, and failures count from zero', async () => {
    const { id, token } = await newMonitor();
    await failN(id, 3);
    await request(app).post(`/api/monitors/${id}/pause`).set(bearer(token)).expect(200);
    await request(app).post(`/api/monitors/${id}/resume`).set(bearer(token)).expect(200);

    expect(await monitorRow(id)).toMatchObject({
      current_status: 'pending', consecutive_failures: 0, failure_streak_started_at: null,
    });
    await failN(id, 2, 1000);
    expect((await incidents(id)).filter((i) => i.status === 'open')).toHaveLength(0);
  });

  it('changing the URL resolves the open incident as monitor_reconfigured', async () => {
    const { id, token } = await newMonitor();
    await failN(id, 3);
    await request(app)
      .patch(`/api/monitors/${id}`).set(bearer(token)).send({ url: 'https://other.example.com/' })
      .expect(200);

    expect((await incidents(id))[0]).toMatchObject({
      status: 'resolved', resolution_reason: 'monitor_reconfigured',
    });
  });

  it('renaming does NOT resolve an open incident', async () => {
    const { id, token } = await newMonitor();
    await failN(id, 3);
    await request(app)
      .patch(`/api/monitors/${id}`).set(bearer(token)).send({ name: 'renamed' }).expect(200);
    expect((await incidents(id))[0].status).toBe('open');
  });

  it('a result that arrives after a pause is ignored: no row, no incident', async () => {
    const { id, token } = await newMonitor();
    await failN(id, 2);
    await request(app).post(`/api/monitors/${id}/pause`).set(bearer(token)).expect(200);

    const out = await record(id, 120, fail(121)); // would have been the 3rd failure
    expect(out).toEqual({ status: 'skipped_inactive' });
    expect(await incidents(id)).toHaveLength(0);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM check_results WHERE monitor_id = $1', [id]);
    expect(rows[0].n).toBe(2);
  });
});