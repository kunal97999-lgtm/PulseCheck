import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { aggregateIncidents } from '../../src/modules/stats/stats.queries.js';
import { overlapSeconds } from '../../src/modules/stats/definitions.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();
const app = createApp();

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const withoutRequestId = (b) => ({ error: { ...b.error, requestId: undefined } });
const HOUR = 3_600_000;
const NOW = new Date('2026-06-01T12:00:00.000Z');
const ago = (h) => new Date(NOW.getTime() - h * HOUR);

async function newMonitor(email = 'alice@example.com') {
  const { token, user } = await registerAndLogin(app, email);
  const res = await request(app).post('/api/monitors').set(bearer(token))
    .send({ name: 'm', url: 'https://api.example.com/health' }).expect(201);
  return { id: res.body.data.monitor.id, token, userId: user.id };
}

// resolvedAgoH === null means still open. Consecutive incidents must not overlap (one open at a time).
async function addIncident(monitorId, startedAgoH, resolvedAgoH) {
  const resolved = resolvedAgoH === null ? null : ago(resolvedAgoH);
  await pool.query(
    `INSERT INTO incidents (monitor_id, status, first_failed_at, started_at, resolved_at, resolution_reason)
     VALUES ($1, $2::text, $3, $3, $4, $5::text)`,
    [monitorId, resolved ? 'resolved' : 'open', ago(startedAgoH), resolved, resolved ? 'recovered' : null],
  );
}

const range = (fromH, toH) => ({ from: ago(fromH), to: ago(toH) });
const downtime = (m, r, now = NOW) => aggregateIncidents(m.id, m.userId, r, now);

describe('aggregateIncidents', () => {
  it('no incidents: zero count, zero downtime', async () => {
    const m = await newMonitor();
    expect(await downtime(m, range(10, 0))).toEqual({ incidentCount: 0, downtimeSeconds: 0 });
  });

  it('an incident fully inside counts in full', async () => {
    const m = await newMonitor();
    await addIncident(m.id, 5, 4);
    expect(await downtime(m, range(10, 0))).toEqual({ incidentCount: 1, downtimeSeconds: 3600 });
  });

  it('is clipped at both window edges', async () => {
    const m = await newMonitor();
    await addIncident(m.id, 12, 8); // 2h of it inside a 10h window
    expect((await downtime(m, range(10, 0))).downtimeSeconds).toBe(2 * 3600);

    const m2 = await newMonitor('b@example.com');
    await addIncident(m2.id, 5, 1);
    expect((await downtime(m2, range(10, 4))).downtimeSeconds).toBe(3600); // only 5h..4h inside
  });

  it('an open incident runs until now, and counts even if it began before the window', async () => {
    const m = await newMonitor();
    await addIncident(m.id, 20, null);
    expect(await downtime(m, range(10, 0))).toEqual({ incidentCount: 1, downtimeSeconds: 10 * 3600 });
  });

  it('incidents entirely outside the window are not counted', async () => {
    const m = await newMonitor();
    await addIncident(m.id, 30, 25);
    await addIncident(m.id, 2, 1);
    expect(await downtime(m, range(20, 10))).toEqual({ incidentCount: 0, downtimeSeconds: 0 });
  });

  it('an incident that ended exactly at `from`, or started exactly at `to`, does not overlap', async () => {
    const m = await newMonitor();
    await addIncident(m.id, 12, 10); // resolved exactly at from
    await addIncident(m.id, 0, null); // started exactly at to (NOW)... open, begins at NOW
    expect(await downtime(m, range(10, 0))).toEqual({ incidentCount: 0, downtimeSeconds: 0 });
  });

  it('several incidents sum, and total never exceeds the window length', async () => {
    const m = await newMonitor();
    await addIncident(m.id, 9, 8);
    await addIncident(m.id, 6, 5);
    await addIncident(m.id, 3, null);
    const got = await downtime(m, range(10, 0));
    expect(got).toEqual({ incidentCount: 3, downtimeSeconds: 1 * 3600 + 1 * 3600 + 3 * 3600 });
    expect(got.downtimeSeconds).toBeLessThanOrEqual(10 * 3600);
  });

  it("agrees with the pure overlapSeconds() reference on many incident shapes", async () => {
    const m = await newMonitor();
    const shapes = [[30, 28], [25, 18], [16, 12], [11, 9.5], [8, 6.25], [4, 2], [1.5, null]];
    for (const [s, r] of shapes) await addIncident(m.id, s, r);
    const r = range(10, 0);

    const want = shapes
      .map(([s, e]) => ({ startedAt: ago(s), resolvedAt: e === null ? null : ago(e) }))
      .map((i) => overlapSeconds(i, r, NOW));
    const got = await downtime(m, r);

    expect(got.downtimeSeconds).toBe(want.reduce((a, b) => a + b, 0));
    expect(got.incidentCount).toBe(want.filter((s) => s > 0).length);
  });

  it("never includes another user's incidents", async () => {
    const a = await newMonitor('alice@example.com');
    const b = await newMonitor('bob@example.com');
    await addIncident(a.id, 5, 4);
    expect(await aggregateIncidents(a.id, b.userId, range(10, 0), NOW)).toEqual({ incidentCount: 0, downtimeSeconds: 0 });
  });
});

describe('GET /api/monitors/:id/stats', () => {
  const get = (token, id, qs = '') =>
    request(app).get(`/api/monitors/${id}/stats${qs ? `?${qs}` : ''}`).set(bearer(token));

  it('requires authentication', async () => {
    expect((await request(app).get(`/api/monitors/${randomUUID()}/stats`)).status).toBe(401);
  });

  it('returns the documented shape for a fresh monitor: nulls and zeros, not errors', async () => {
    const m = await newMonitor();
    const res = await get(m.token, m.id);
    expect(res.status).toBe(200);
    const s = res.body.data.stats;
    expect(Object.keys(s).sort()).toEqual([
      'coveragePercent', 'expectedChecks', 'failures', 'incidents', 'latency', 'monitor',
      'observations', 'successes', 'uptimePercent', 'window',
    ]);
    expect(s).toMatchObject({
      observations: 0, uptimePercent: null,
      latency: { averageMs: null, p95Ms: null },
      incidents: { count: 0, downtimeSeconds: 0 },
      monitor: { id: m.id, status: 'pending', isActive: true, lastCheckedAt: null },
    });
  });

  it('reports real numbers end to end', async () => {
    const m = await newMonitor();
    const t = Date.now();
    await pool.query(
      `INSERT INTO check_results (monitor_id, scheduled_for, checked_at, success, status_code, latency_ms, error_type, error_message)
       SELECT $1::uuid, to_timestamp($2::bigint / 1000.0) - (g * interval '1 minute'), to_timestamp($2::bigint / 1000.0) - (g * interval '1 minute'),
              g <> 2, CASE WHEN g <> 2 THEN 200 ELSE 503 END, 100 * g,
              CASE WHEN g <> 2 THEN NULL ELSE 'http_status' END, CASE WHEN g <> 2 THEN NULL ELSE 'bad' END
         FROM generate_series(1, 4) g`,
      [m.id, t],
    );
    const s = (await get(m.token, m.id)).body.data.stats;
    expect(s).toMatchObject({
      observations: 4, successes: 3, failures: 1, uptimePercent: 75,
      latency: { averageMs: 266.7, p95Ms: 400 }, // successes: 100, 300, 400
    });
  });

  it('includes incident count and downtime, and the two can disagree with uptime', async () => {
    const m = await newMonitor();
    const t = Date.now();
    await pool.query(
      `INSERT INTO incidents (monitor_id, status, first_failed_at, started_at, resolved_at, resolution_reason)
       VALUES ($1, 'resolved', $2, $2, $3, 'recovered')`,
      [m.id, new Date(t - 3 * HOUR), new Date(t - 2 * HOUR)],
    );
    const s = (await get(m.token, m.id)).body.data.stats;
    expect(s.incidents.count).toBe(1);
    expect(s.incidents.downtimeSeconds).toBeGreaterThanOrEqual(3599);
    expect(s.incidents.downtimeSeconds).toBeLessThanOrEqual(3600);
    expect(s.uptimePercent).toBeNull(); // no checks stored: downtime exists independent of uptime
  });

  it('accepts a from/to window', async () => {
    const m = await newMonitor();
    const res = await get(m.token, m.id, `from=${ago(48).toISOString()}&to=${ago(24).toISOString()}`);
    expect(res.status).toBe(200);
    expect(new Date(res.body.data.stats.window.from)).toEqual(ago(48));
  });

  it("returns 404 for another user's monitor, identical to a nonexistent one", async () => {
    const a = await newMonitor('alice@example.com');
    const b = await newMonitor('bob@example.com');
    const cross = await get(b.token, a.id);
    const missing = await get(b.token, randomUUID());
    expect(cross.status).toBe(404);
    expect(withoutRequestId(cross.body)).toEqual(withoutRequestId(missing.body));
  });

  it.each([
    ['from=yesterday'],
    ['to=nonsense'],
    [`from=${new Date(Date.now() - 31 * 86_400_000).toISOString()}`],
    [`from=${new Date(Date.now() - 1000).toISOString()}&to=${new Date(Date.now() - 2000).toISOString()}`],
  ])('rejects %s with a 400', async (qs) => {
    const m = await newMonitor();
    const res = await get(m.token, m.id, qs);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('clamps a future `to` instead of failing', async () => {
    const m = await newMonitor();
    const res = await get(m.token, m.id, `to=${new Date(Date.now() + 86_400_000).toISOString()}`);
    expect(res.status).toBe(200);
    expect(new Date(res.body.data.stats.window.to).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});