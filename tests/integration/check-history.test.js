import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();
const app = createApp();

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const withoutRequestId = (b) => ({ error: { ...b.error, requestId: undefined } });
const iso = (ms) => new Date(ms).toISOString();
const BASE = Math.floor(Date.now() / 1000) * 1000 - 3_600_000; // one hour ago, on a whole second

async function newMonitor(email = 'alice@example.com') {
  const { token } = await registerAndLogin(app, email);
  const res = await request(app).post('/api/monitors').set(bearer(token))
    .send({ name: 'm', url: 'https://api.example.com/health' }).expect(201);
  return { token, id: res.body.data.monitor.id };
}

// rows: [{ sched, checked, ok }] with ISO strings (microsecond strings allowed)
async function insertChecks(monitorId, rows) {
  await pool.query(
    `INSERT INTO check_results (monitor_id, scheduled_for, checked_at, success, status_code, latency_ms, error_type, error_message)
     SELECT $1::uuid, x.s, x.t, x.ok, CASE WHEN x.ok THEN 200 ELSE 503 END, 100,
            CASE WHEN x.ok THEN NULL ELSE 'http_status' END, CASE WHEN x.ok THEN NULL ELSE 'bad' END
       FROM unnest($2::timestamptz[], $3::timestamptz[], $4::boolean[]) AS x(s, t, ok)`,
    [monitorId, rows.map((r) => r.sched), rows.map((r) => r.checked), rows.map((r) => r.ok ?? true)],
  );
}
// k = 0 is the newest row.
const series = (n, { stepSec = 60, okFn = () => true } = {}) =>
  Array.from({ length: n }, (_, k) => ({
    sched: iso(BASE - k * stepSec * 1000), checked: iso(BASE - k * stepSec * 1000), ok: okFn(k),
  }));

const getChecks = (token, id, qs = '') =>
  request(app).get(`/api/monitors/${id}/checks${qs ? `?${qs}` : ''}`).set(bearer(token));

async function walk(token, id, { limit = 50, extra = '' } = {}) {
  const pages = [];
  let cursor = null;
  for (let guard = 0; guard < 60; guard++) {
    const res = await getChecks(token, id, `limit=${limit}${extra}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(res.status).toBe(200);
    pages.push(res.body.data.checks);
    cursor = res.body.meta.nextCursor;
    if (!cursor) break;
  }
  return pages;
}

describe('authentication and ownership', () => {
  it('returns 401 without a token', async () => {
    expect((await request(app).get(`/api/monitors/${randomUUID()}/checks`)).status).toBe(401);
  });

  it("returns 404 for another user's monitor, identical to a nonexistent one", async () => {
    const alice = await newMonitor('alice@example.com');
    const bob = await newMonitor('bob@example.com');
    await insertChecks(alice.id, series(3));
    const cross = await getChecks(bob.token, alice.id);
    const missing = await getChecks(bob.token, randomUUID());
    expect(cross.status).toBe(404);
    expect(withoutRequestId(cross.body)).toEqual(withoutRequestId(missing.body));
  });

  it("a cursor from one monitor cannot expose another user's rows", async () => {
    const alice = await newMonitor('alice@example.com');
    const bob = await newMonitor('bob@example.com');
    await insertChecks(alice.id, series(10));
    await insertChecks(bob.id, series(3, { stepSec: 90 }));
    const cursor = (await getChecks(alice.token, alice.id, 'limit=2')).body.meta.nextCursor;

    const res = await getChecks(bob.token, bob.id, `cursor=${cursor}`);
    expect(res.status).toBe(200);
    const bobSched = new Set(series(3, { stepSec: 90 }).map((r) => r.sched));
    expect(res.body.data.checks.every((c) => bobSched.has(c.scheduledFor))).toBe(true);
  });
});

describe('response shape', () => {
  it('exposes only the documented fields, newest first', async () => {
    const { token, id } = await newMonitor();
    await insertChecks(id, series(3, { okFn: (k) => k !== 1 }));
    const res = await getChecks(token, id);
    const [first, second] = res.body.data.checks;
    expect(Object.keys(first).sort()).toEqual(
      ['checkedAt', 'errorMessage', 'errorType', 'latencyMs', 'scheduledFor', 'statusCode', 'success']);
    expect(first).toMatchObject({ success: true, statusCode: 200, errorType: null });
    expect(second).toMatchObject({ success: false, statusCode: 503, errorType: 'http_status', errorMessage: 'bad' });
    expect(new Date(first.checkedAt) > new Date(second.checkedAt)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/monitor_?id|user_?id/i);
  });

  it('an empty history is an empty list with no cursor', async () => {
    const { token, id } = await newMonitor();
    const res = await getChecks(token, id);
    expect(res.body.data.checks).toEqual([]);
    expect(res.body.meta).toEqual({ limit: 50, nextCursor: null });
  });
});

describe('keyset pagination', () => {
  it('walks 125 rows in pages of 50/50/25: every row once, in order', async () => {
    const { token, id } = await newMonitor();
    const rows = series(125);
    await insertChecks(id, rows);

    const pages = await walk(token, id);
    expect(pages.map((p) => p.length)).toEqual([50, 50, 25]);
    const sched = pages.flat().map((c) => c.scheduledFor);
    expect(sched).toEqual(rows.map((r) => r.sched)); // exact order, nothing missing, nothing repeated
  });

  it('an exact multiple of the page size ends cleanly: no cursor to an empty page', async () => {
    const { token, id } = await newMonitor();
    await insertChecks(id, series(100));
    const pages = await walk(token, id);
    expect(pages.map((p) => p.length)).toEqual([50, 50]);
  });

  it('rows with IDENTICAL checked_at are neither skipped nor repeated across a page boundary', async () => {
    const { token, id } = await newMonitor();
    const same = iso(BASE);
    const rows = Array.from({ length: 7 }, (_, k) => ({ sched: iso(BASE - k * 1000), checked: same }));
    await insertChecks(id, rows);

    const pages = await walk(token, id, { limit: 3 });
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    const got = pages.flat().map((c) => c.scheduledFor);
    expect(new Set(got).size).toBe(7);
    expect([...got].sort()).toEqual(rows.map((r) => r.sched).sort());
  });

  it('timestamps that differ only below a millisecond still paginate correctly', async () => {
    const { token, id } = await newMonitor();
    const t = new Date(BASE).toISOString().slice(0, 19); // seconds precision
    await insertChecks(id, [
      { sched: iso(BASE), checked: `${t}.000300Z` },
      { sched: iso(BASE - 1000), checked: `${t}.000200Z` },
      { sched: iso(BASE - 2000), checked: `${t}.000100Z` },
    ]);
    const pages = await walk(token, id, { limit: 1 });
    expect(pages.map((p) => p.length)).toEqual([1, 1, 1]);
    expect(pages.flat().map((c) => c.scheduledFor)).toEqual([iso(BASE), iso(BASE - 1000), iso(BASE - 2000)]);
  });

  it('a NEW check arriving between pages does not shift or duplicate anything', async () => {
    const { token, id } = await newMonitor();
    const rows = series(20);
    await insertChecks(id, rows);

    const page1 = await getChecks(token, id, 'limit=5');
    await insertChecks(id, [{ sched: iso(BASE + 30_000), checked: iso(BASE + 30_000) }]); // newer than everything
    const page2 = await getChecks(token, id, `limit=5&cursor=${page1.body.meta.nextCursor}`);

    expect(page2.body.data.checks.map((c) => c.scheduledFor)).toEqual(rows.slice(5, 10).map((r) => r.sched));
  });
});

describe('filters', () => {
  it('defaults to the last 24 hours', async () => {
    const { token, id } = await newMonitor();
    await insertChecks(id, [
      { sched: iso(BASE), checked: iso(BASE) },
      { sched: iso(BASE - 3 * 86_400_000), checked: iso(BASE - 3 * 86_400_000) },
    ]);
    expect((await getChecks(token, id)).body.data.checks).toHaveLength(1);
  });

  it('from/to select a window: from is inclusive, to is exclusive', async () => {
    const { token, id } = await newMonitor();
    await insertChecks(id, series(5, { stepSec: 3600 })); // 1h, 2h, 3h, 4h, 5h ago
    const from = iso(BASE - 3 * 3_600_000);
    const to = iso(BASE - 1 * 3_600_000);
    const res = await getChecks(token, id, `from=${from}&to=${to}`);
    expect(res.body.data.checks.map((c) => c.scheduledFor)).toEqual([iso(BASE - 2 * 3_600_000), iso(BASE - 3 * 3_600_000)]);
  });

  it('filters by success', async () => {
    const { token, id } = await newMonitor();
    await insertChecks(id, series(10, { okFn: (k) => k % 5 !== 0 })); // 2 failures
    const failed = await getChecks(token, id, 'success=false');
    const ok = await getChecks(token, id, 'success=true');
    expect(failed.body.data.checks.every((c) => c.success === false)).toBe(true);
    expect(failed.body.data.checks).toHaveLength(2);
    expect(ok.body.data.checks).toHaveLength(8);
  });

  it('pages correctly while filtered', async () => {
    const { token, id } = await newMonitor();
    await insertChecks(id, series(30, { okFn: (k) => k % 3 !== 0 })); // 10 failures
    const pages = await walk(token, id, { limit: 4, extra: '&success=false' });
    expect(pages.flat()).toHaveLength(10);
    expect(pages.flat().every((c) => c.success === false)).toBe(true);
  });
});

describe('validation', () => {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  it.each([
    ['limit=0'], ['limit=101'], ['limit=abc'],
    ['cursor=garbage'],
    [`cursor=${b64('{"t":"2026-01-01T00:00:00.000000Z","i":"1; DROP TABLE users"}')}`],
    ['from=yesterday'], ['to=2026-13-45T00:00:00Z'],
    ['success=maybe'],
    [`from=${iso(Date.now() - 31 * 86_400_000)}`],
    [`from=${iso(Date.now() - 1000)}&to=${iso(Date.now() - 2000)}`],
  ])('rejects %s with a 400', async (qs) => {
    const { token, id } = await newMonitor();
    const res = await getChecks(token, id, qs);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a future `to` is clamped, not rejected', async () => {
    const { token, id } = await newMonitor();
    await insertChecks(id, series(2));
    const res = await getChecks(token, id, `to=${iso(Date.now() + 86_400_000)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.checks).toHaveLength(2);
  });
});