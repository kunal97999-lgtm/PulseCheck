import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { aggregateChecks } from '../../src/modules/stats/stats.queries.js';
import { getCheckStats } from '../../src/modules/stats/stats.service.js';
import { NotFoundError } from '../../src/utils/errors.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();
const app = createApp();

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const START = Date.UTC(2026, 0, 1, 0, 0, 0); // fixed: results never depend on today's date
const STEP = 100_000; // one row per 100 s, so (monitor, scheduled_for) is always unique

// Deterministic PRNG (mulberry32): the same "random" data on every run.
function prng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genRows(n, seed) {
  const rand = prng(seed);
  return Array.from({ length: n }, (_, k) => {
    const sched = START + k * STEP;
    const ok = rand() < 0.85;
    return {
      sched,
      checked: sched + Math.floor(rand() * 50_000), // always inside its own 100 s slot
      ok,
      // 5% of SUCCESSES have no latency; failures keep a latency (a timeout records one)
      lat: ok && rand() < 0.05 ? null : 20 + Math.floor(rand() * 480),
    };
  });
}

async function insertRows(monitorId, rows) {
  await pool.query(
    `INSERT INTO check_results (monitor_id, scheduled_for, checked_at, success, status_code, latency_ms, error_type, error_message)
     SELECT $1::uuid, to_timestamp(x.s / 1000.0), to_timestamp(x.t / 1000.0), x.ok,
            CASE WHEN x.ok THEN 200 ELSE 503 END, x.lat,
            CASE WHEN x.ok THEN NULL ELSE 'http_status' END, CASE WHEN x.ok THEN NULL ELSE 'bad' END
       FROM unnest($2::bigint[], $3::bigint[], $4::boolean[], $5::int[]) AS x(s, t, ok, lat)`,
    [monitorId, rows.map((r) => r.sched), rows.map((r) => r.checked), rows.map((r) => r.ok), rows.map((r) => r.lat)],
  );
}

// The independent reference: plain JS, no SQL semantics shared with the query.
function reference(rows, from, to) {
  const inWindow = rows.filter((r) => r.checked >= from && r.checked < to);
  const ok = inWindow.filter((r) => r.ok);
  const lat = ok.map((r) => r.lat).filter((v) => v !== null).sort((a, b) => a - b);
  return {
    total: inWindow.length,
    successes: ok.length,
    failures: inWindow.length - ok.length,
    avgMs: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
    p95Ms: lat.length ? lat[Math.ceil(0.95 * lat.length) - 1] : null, // percentile_disc
  };
}

async function newMonitor(email = 'alice@example.com') {
  const { token, user } = await registerAndLogin(app, email);
  const res = await request(app).post('/api/monitors').set(bearer(token))
    .send({ name: 'm', url: 'https://api.example.com/health' }).expect(201);
  return { id: res.body.data.monitor.id, token, userId: user.id };
}
const win = (from, to) => ({ from: new Date(from), to: new Date(to) });

describe('aggregateChecks agrees with an independent JS reference', () => {
  it.each([
    ['the whole data set', 0, 400],
    ['the first third', 0, 130],
    ['a middle slice', 100, 250],
    ['a tiny slice (few samples, coarse p95)', 7, 11],
    ['a window past the data', 500, 600],
  ])('window: %s', async (_n, fromK, toK) => {
    const m = await newMonitor();
    const rows = genRows(300, 12345);
    await insertRows(m.id, rows);

    const from = START + fromK * STEP;
    const to = START + toK * STEP;
    const got = await aggregateChecks(m.id, m.userId, win(from, to));
    const want = reference(rows, from, to);

    expect(got.total).toBe(want.total);
    expect(got.successes).toBe(want.successes);
    expect(got.failures).toBe(want.failures);
    expect(got.p95Ms).toBe(want.p95Ms);
    if (want.avgMs === null) expect(got.avgMs).toBeNull();
    else expect(got.avgMs).toBeCloseTo(want.avgMs, 6);
  });

  it('holds for several different random data sets', async () => {
    for (const seed of [1, 2, 3, 99, 2026]) {
      const m = await newMonitor(`seed${seed}@example.com`);
      const rows = genRows(200, seed);
      await insertRows(m.id, rows);
      const from = START + 20 * STEP;
      const to = START + 180 * STEP;
      const got = await aggregateChecks(m.id, m.userId, win(from, to));
      const want = reference(rows, from, to);
      expect([got.total, got.successes, got.p95Ms]).toEqual([want.total, want.successes, want.p95Ms]);
      expect(got.avgMs).toBeCloseTo(want.avgMs, 6);
    }
  });
});

describe('hand-checkable cases (so the reference is not the only oracle)', () => {
  it('p95 of 1..20 is 19, of 1..100 is 95 (position ceil(0.95 n))', async () => {
    const m = await newMonitor();
    await insertRows(m.id, Array.from({ length: 20 }, (_, k) => ({
      sched: START + k * STEP, checked: START + k * STEP, ok: true, lat: k + 1 })));
    expect((await aggregateChecks(m.id, m.userId, win(START, START + 30 * STEP))).p95Ms).toBe(19);

    const m2 = await newMonitor('b@example.com');
    await insertRows(m2.id, Array.from({ length: 100 }, (_, k) => ({
      sched: START + k * STEP, checked: START + k * STEP, ok: true, lat: k + 1 })));
    expect((await aggregateChecks(m2.id, m2.userId, win(START, START + 200 * STEP))).p95Ms).toBe(95);
  });

  it('failures never enter latency statistics, however large their latency', async () => {
    const m = await newMonitor();
    await insertRows(m.id, [
      { sched: START, checked: START, ok: true, lat: 100 },
      { sched: START + STEP, checked: START + STEP, ok: true, lat: 200 },
      { sched: START + 2 * STEP, checked: START + 2 * STEP, ok: false, lat: 30_000 }, // a timeout
    ]);
    const got = await aggregateChecks(m.id, m.userId, win(START, START + 10 * STEP));
    expect(got).toMatchObject({ total: 3, successes: 2, failures: 1, avgMs: 150, p95Ms: 200 });
  });

  it('a success with NULL latency counts toward uptime but not latency', async () => {
    const m = await newMonitor();
    await insertRows(m.id, [
      { sched: START, checked: START, ok: true, lat: null },
      { sched: START + STEP, checked: START + STEP, ok: true, lat: 80 },
    ]);
    const got = await aggregateChecks(m.id, m.userId, win(START, START + 10 * STEP));
    expect(got).toMatchObject({ total: 2, successes: 2, avgMs: 80, p95Ms: 80 });
  });

  it('only failures: counts are right and both latency figures are null', async () => {
    const m = await newMonitor();
    await insertRows(m.id, [{ sched: START, checked: START, ok: false, lat: 500 }]);
    expect(await aggregateChecks(m.id, m.userId, win(START, START + STEP)))
      .toEqual({ total: 1, successes: 0, failures: 1, avgMs: null, p95Ms: null });
  });

  it('an empty window returns zeros and nulls, not an error', async () => {
    const m = await newMonitor();
    expect(await aggregateChecks(m.id, m.userId, win(START, START + STEP)))
      .toEqual({ total: 0, successes: 0, failures: 0, avgMs: null, p95Ms: null });
  });

  it('`from` is inclusive and `to` is exclusive, to the millisecond', async () => {
    const m = await newMonitor();
    const T = START + 10 * STEP;
    await insertRows(m.id, [
      { sched: T - 1000, checked: T - 1, ok: true, lat: 10 }, // just before from
      { sched: T, checked: T, ok: true, lat: 20 }, // exactly at from: IN
      { sched: T + 1000, checked: T + 999, ok: true, lat: 30 }, // inside
      { sched: T + 2000, checked: T + 1000, ok: true, lat: 40 }, // exactly at to: OUT
    ]);
    const got = await aggregateChecks(m.id, m.userId, win(T, T + 1000));
    expect(got.total).toBe(2);
    expect(got.avgMs).toBe(25);
  });
});

describe('isolation', () => {
  it("another monitor's rows never leak in, and a foreign user gets zeros", async () => {
    const a = await newMonitor('alice@example.com');
    const b = await newMonitor('bob@example.com');
    await insertRows(a.id, genRows(50, 7));
    await insertRows(b.id, genRows(10, 8));

    const w = win(START, START + 100 * STEP);
    expect((await aggregateChecks(a.id, a.userId, w)).total).toBe(50);
    expect((await aggregateChecks(b.id, b.userId, w)).total).toBe(10);
    expect((await aggregateChecks(a.id, b.userId, w)).total).toBe(0); // Bob asking about Alice's monitor
  });
});

describe('getCheckStats (service)', () => {
  const NOW = new Date(START + 6 * 3_600_000); // 06:00 on the data's day

  it('combines aggregates with coverage for a monitor with a known age', async () => {
    const m = await newMonitor();
    await pool.query(`UPDATE monitors SET created_at = $2, interval_seconds = 300 WHERE id = $1`,
      [m.id, new Date(START - 86_400_000)]);
    // One hour of data: 6 successes at 100 ms, in the hour before NOW.
    const from = NOW.getTime() - 3_600_000;
    await insertRows(m.id, Array.from({ length: 6 }, (_, k) => ({
      sched: from + k * 600_000, checked: from + k * 600_000, ok: true, lat: 100 })));

    const s = await getCheckStats(m.userId, m.id, { from: new Date(from), to: NOW }, NOW);
    expect(s).toMatchObject({
      observations: 6, successes: 6, failures: 0, uptimePercent: 100,
      expectedChecks: 12, coveragePercent: 50,
      latency: { averageMs: 100, p95Ms: 100 },
    });
  });

  it('missing checks are NOT successes: 6 of 12 expected, 3 failed, uptime is 50 and coverage 50', async () => {
    const m = await newMonitor();
    await pool.query(`UPDATE monitors SET created_at = $2 WHERE id = $1`, [m.id, new Date(START - 86_400_000)]);
    const from = NOW.getTime() - 3_600_000;
    await insertRows(m.id, Array.from({ length: 6 }, (_, k) => ({
      sched: from + k * 600_000, checked: from + k * 600_000, ok: k % 2 === 0, lat: 100 })));
    const s = await getCheckStats(m.userId, m.id, { from: new Date(from), to: NOW }, NOW);
    expect(s).toMatchObject({ uptimePercent: 50, coveragePercent: 50 });
  });

  it('defaults to the last 24 hours and returns 404 for a foreign or missing monitor', async () => {
    const a = await newMonitor('alice@example.com');
    const b = await newMonitor('bob@example.com');
    const s = await getCheckStats(a.userId, a.id, {}, NOW);
    expect(s.window.to).toEqual(NOW);
    expect(s.window.from).toEqual(new Date(NOW.getTime() - 86_400_000));

    await expect(getCheckStats(b.userId, a.id, {}, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCheckStats(a.userId, randomUUID(), {}, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});