import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();
const app = createApp();

const validBody = { name: 'Prod API', url: 'https://api.example.com/health' };
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const create = (token, body = validBody) =>
  request(app).post('/api/monitors').set(bearer(token)).send(body);
const withoutRequestId = (body) => ({ error: { ...body.error, requestId: undefined } });

describe('authentication required', () => {
  it.each([
    ['POST', '/api/monitors'],
    ['GET', '/api/monitors'],
    ['GET', `/api/monitors/${randomUUID()}`],
  ])('%s %s returns 401 without a token', async (method, path) => {
    const res = await request(app)[method.toLowerCase()](path);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/monitors', () => {
  it('creates a monitor with documented defaults and no internal fields', async () => {
    const { token } = await registerAndLogin(app);
    const res = await create(token);

    expect(res.status).toBe(201);
    const m = res.body.data.monitor;
    expect(m).toMatchObject({
      name: 'Prod API',
      url: 'https://api.example.com/health',
      intervalSeconds: 300,
      timeoutMs: 10000,
      expectedStatus: { min: 200, max: 299 },
      failureThreshold: 3,
      recoveryThreshold: 1,
      isActive: true,
      status: 'pending',
      consecutiveFailures: 0,
    });
    expect(m.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(m).not.toHaveProperty('userId');
    expect(m).not.toHaveProperty('user_id');
  });

  it('schedules the first check immediately', async () => {
    const { token } = await registerAndLogin(app);
    await create(token).expect(201);
    const { rows } = await pool.query(
      `SELECT next_check_at <= now() AS due FROM monitors`,
    );
    expect(rows[0].due).toBe(true);
  });

  it('strips URL fragments', async () => {
    const { token } = await registerAndLogin(app);
    const res = await create(token, { ...validBody, url: 'https://api.example.com/health#top' });
    expect(res.body.data.monitor.url).toBe('https://api.example.com/health');
  });

  it.each([
    ['ftp scheme', 'ftp://example.com/file'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['not a URL', 'not a url'],
    ['embedded credentials', 'https://user:pass@example.com/health'],
    ['disallowed port', 'https://example.com:22/health'],
    ['too long', `https://example.com/${'a'.repeat(2050)}`],
  ])('rejects URL: %s', async (_name, url) => {
    const { token } = await registerAndLogin(app);
    const res = await create(token, { ...validBody, url });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.some((d) => d.field === 'url')).toBe(true);
  });

  it.each([
    ['interval below minimum', { intervalSeconds: 59 }],
    ['interval above maximum', { intervalSeconds: 86401 }],
    ['timeout below minimum', { timeoutMs: 999 }],
    ['timeout above maximum', { timeoutMs: 30001 }],
    ['threshold of zero', { failureThreshold: 0 }],
    ['numbers sent as strings', { intervalSeconds: '60' }],
    ['inverted status range', { expectedStatusMin: 300, expectedStatusMax: 200 }],
    ['empty name', { name: '   ' }],
  ])('rejects config: %s', async (_name, override) => {
    const { token } = await registerAndLogin(app);
    const res = await create(token, { ...validBody, ...override });
    expect(res.status).toBe(400);
  });

  it('accepts the exact boundary values', async () => {
    const { token } = await registerAndLogin(app);
    await create(token, { ...validBody, intervalSeconds: 60, timeoutMs: 1000 }).expect(201);
    await create(token, { ...validBody, intervalSeconds: 86400, timeoutMs: 30000 }).expect(201);
  });

  it.each([
    ['userId', { userId: randomUUID() }],
    ['isActive', { isActive: false }],
    ['status', { currentStatus: 'up' }],
  ])('rejects unknown/server-controlled field: %s (mass assignment)', async (_name, extra) => {
    const { token } = await registerAndLogin(app);
    const res = await create(token, { ...validBody, ...extra });
    expect(res.status).toBe(400);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM monitors');
    expect(rows[0].n).toBe(0);
  });
});

describe('ownership (GET /api/monitors/:id)', () => {
  it('returns the monitor to its owner', async () => {
    const { token } = await registerAndLogin(app);
    const id = (await create(token)).body.data.monitor.id;
    const res = await request(app).get(`/api/monitors/${id}`).set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.monitor.id).toBe(id);
  });

  it("returns 404 for another user's monitor, identical to a nonexistent one", async () => {
    const alice = await registerAndLogin(app, 'alice@example.com');
    const bob = await registerAndLogin(app, 'bob@example.com');
    const aliceMonitorId = (await create(alice.token)).body.data.monitor.id;

    const crossUser = await request(app).get(`/api/monitors/${aliceMonitorId}`).set(bearer(bob.token));
    const nonexistent = await request(app).get(`/api/monitors/${randomUUID()}`).set(bearer(bob.token));

    expect(crossUser.status).toBe(404);
    expect(crossUser.body.error.code).toBe('NOT_FOUND');
    expect(withoutRequestId(crossUser.body)).toEqual(withoutRequestId(nonexistent.body));
  });

  it('returns 400 for a malformed id instead of a 500', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).get('/api/monitors/not-a-uuid').set(bearer(token));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/monitors', () => {
  it("lists only the caller's monitors", async () => {
    const alice = await registerAndLogin(app, 'alice@example.com');
    const bob = await registerAndLogin(app, 'bob@example.com');
    await create(alice.token, { ...validBody, name: 'A1' });
    await create(alice.token, { ...validBody, name: 'A2' });
    await create(bob.token, { ...validBody, name: 'B1' });

    const a = await request(app).get('/api/monitors').set(bearer(alice.token));
    const b = await request(app).get('/api/monitors').set(bearer(bob.token));

    expect(a.body.data.monitors.map((m) => m.name)).toEqual(['A2', 'A1']); // newest first
    expect(b.body.data.monitors.map((m) => m.name)).toEqual(['B1']);
  });

  it('paginates with limit and offset', async () => {
    const { token } = await registerAndLogin(app);
    for (const name of ['M1', 'M2', 'M3']) await create(token, { ...validBody, name });

    const page1 = await request(app).get('/api/monitors?limit=2').set(bearer(token));
    const page2 = await request(app).get('/api/monitors?limit=2&offset=2').set(bearer(token));
    const beyond = await request(app).get('/api/monitors?limit=2&offset=10').set(bearer(token));

    expect(page1.body.data.monitors.map((m) => m.name)).toEqual(['M3', 'M2']);
    expect(page2.body.data.monitors.map((m) => m.name)).toEqual(['M1']);
    expect(beyond.body.data.monitors).toEqual([]);
    expect(page1.body.meta).toEqual({ limit: 2, offset: 0 });
  });

  it.each(['limit=0', 'limit=101', 'limit=abc', 'offset=-1'])('rejects %s', async (qs) => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).get(`/api/monitors?${qs}`).set(bearer(token));
    expect(res.status).toBe(400);
  });
});

describe('monitor quota (MAX_MONITORS_PER_USER=3 in .env.test)', () => {
  it('blocks creation beyond the limit, per user', async () => {
    const alice = await registerAndLogin(app, 'alice@example.com');
    const bob = await registerAndLogin(app, 'bob@example.com');
    for (let i = 0; i < 3; i++) await create(alice.token).expect(201);

    const res = await create(alice.token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MONITOR_LIMIT_REACHED');

    await create(bob.token).expect(201); // Alice's quota doesn't affect Bob
  });

  it('cannot be exceeded by concurrent requests', async () => {
    const { token } = await registerAndLogin(app);
    const responses = await Promise.all(Array.from({ length: 6 }, () => create(token)));

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 403)).toHaveLength(3);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM monitors');
    expect(rows[0].n).toBe(3);
  });
});

describe('database-level guarantees', () => {
  it('rejects out-of-range values even when application validation is bypassed', async () => {
    const { user } = await registerAndLogin(app);
    await expect(
      pool.query(
        `INSERT INTO monitors (user_id, name, url, interval_seconds) VALUES ($1, 'x', 'https://a.com', 5)`,
        [user.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'monitors_interval_range' });
  });

  it('deletes monitors when the user is deleted (ON DELETE CASCADE)', async () => {
    const { token, user } = await registerAndLogin(app);
    await create(token).expect(201);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM monitors');
    expect(rows[0].n).toBe(0);
  });
});