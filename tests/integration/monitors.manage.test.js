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

const createMonitor = async (token, body = validBody) =>
  (await request(app).post('/api/monitors').set(bearer(token)).send(body).expect(201)).body.data
    .monitor;
const patch = (token, id, body) =>
  request(app).patch(`/api/monitors/${id}`).set(bearer(token)).send(body);
const act = (method, token, id, suffix = '') =>
  request(app)[method](`/api/monitors/${id}${suffix}`).set(bearer(token));
const dbRow = async (id) =>
  (await pool.query('SELECT * FROM monitors WHERE id = $1', [id])).rows[0];
const forceState = (id, status, failures) =>
  pool.query(
    `UPDATE monitors SET current_status = $2, consecutive_failures = $3 WHERE id = $1`,
    [id, status, failures],
  );

describe('authentication required', () => {
  const id = randomUUID();
  it.each([
    ['PATCH', `/api/monitors/${id}`],
    ['DELETE', `/api/monitors/${id}`],
    ['POST', `/api/monitors/${id}/pause`],
    ['POST', `/api/monitors/${id}/resume`],
  ])('%s %s returns 401 without a token', async (method, path) => {
    const res = await request(app)[method.toLowerCase()](path);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/monitors/:id', () => {
  it('changes only the provided fields and bumps updatedAt', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);

    const res = await patch(token, created.id, { name: 'Renamed', timeoutMs: 5000 });
    expect(res.status).toBe(200);
    const m = res.body.data.monitor;
    expect(m).toMatchObject({
      name: 'Renamed',
      timeoutMs: 5000,
      url: created.url,
      intervalSeconds: 300,
      expectedStatus: { min: 200, max: 299 },
    });
    expect(new Date(m.updatedAt) > new Date(created.updatedAt)).toBe(true);
  });

  it('clears the description with null', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token, { ...validBody, description: 'hello' });
    const res = await patch(token, created.id, { description: null });
    expect(res.status).toBe(200);
    expect(res.body.data.monitor.description).toBeNull();
  });

  it('rejects an empty body', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);
    const res = await patch(token, created.id, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['userId', { userId: randomUUID() }],
    ['isActive (use pause/resume)', { isActive: false }],
    ['currentStatus', { currentStatus: 'up' }],
    ['consecutiveFailures', { consecutiveFailures: 99 }],
  ])('rejects server-controlled field: %s (mass assignment)', async (_n, extra) => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);
    const res = await patch(token, created.id, { name: 'x', ...extra });
    expect(res.status).toBe(400);
    expect((await dbRow(created.id)).name).toBe('Prod API'); // nothing was applied
  });

  it.each([
    ['interval below minimum', { intervalSeconds: 59 }],
    ['timeout above maximum', { timeoutMs: 30001 }],
    ['bad URL scheme', { url: 'ftp://example.com' }],
    ['URL with credentials', { url: 'https://u:p@example.com' }],
    ['disallowed port', { url: 'https://example.com:22' }],
    ['empty name', { name: '  ' }],
  ])('rejects invalid value: %s', async (_n, body) => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);
    expect((await patch(token, created.id, body)).status).toBe(400);
  });

  it('validates the MERGED status range, not just the provided fields', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token); // stored range 200-299

    const bad = await patch(token, created.id, { expectedStatusMin: 300 });
    expect(bad.status).toBe(400); // must be a 400, never a 500 from the DB constraint
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const good = await patch(token, created.id, { expectedStatusMin: 250 });
    expect(good.status).toBe(200);
    expect(good.body.data.monitor.expectedStatus).toEqual({ min: 250, max: 299 });
  });

  it('resets health state and schedules a check when the URL changes', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);
    await forceState(created.id, 'down', 2);
    await pool.query(`UPDATE monitors SET next_check_at = now() + interval '1 hour'`);

    const res = await patch(token, created.id, { url: 'https://other.example.com/health' });
    expect(res.status).toBe(200);
    expect(res.body.data.monitor.status).toBe('pending');
    expect(res.body.data.monitor.consecutiveFailures).toBe(0);
    const row = await dbRow(created.id);
    expect(row.consecutive_successes).toBe(0);
    expect(row.next_check_at <= new Date()).toBe(true);
  });

  it('keeps health state when a non-URL field changes', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);
    await forceState(created.id, 'down', 2);

    const res = await patch(token, created.id, { name: 'Renamed' });
    expect(res.body.data.monitor.status).toBe('down');
    expect(res.body.data.monitor.consecutiveFailures).toBe(2);
  });

  it('pulls the next check earlier when the interval is shortened', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token, { ...validBody, intervalSeconds: 86400 });
    await pool.query(`UPDATE monitors SET next_check_at = now() + interval '1 day'`);

    await patch(token, created.id, { intervalSeconds: 60 }).expect(200);
    const { rows } = await pool.query(
      `SELECT next_check_at <= now() + interval '61 seconds' AS pulled FROM monitors`,
    );
    expect(rows[0].pulled).toBe(true);
  });

  it('does not postpone a due check when the interval is lengthened', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token); // next_check_at = now()
    await patch(token, created.id, { intervalSeconds: 3600 }).expect(200);
    expect((await dbRow(created.id)).next_check_at <= new Date()).toBe(true);
  });

  it('keeps a paused monitor unscheduled after an edit', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);
    await act('post', token, created.id, '/pause').expect(200);
    await patch(token, created.id, { url: 'https://other.example.com' }).expect(200);
    const row = await dbRow(created.id);
    expect(row.is_active).toBe(false);
    expect(row.next_check_at).toBeNull();
  });

  it("returns 404 for another user's monitor and leaves it unchanged", async () => {
    const alice = await registerAndLogin(app, 'alice@example.com');
    const bob = await registerAndLogin(app, 'bob@example.com');
    const created = await createMonitor(alice.token);

    const res = await patch(bob.token, created.id, { name: 'hacked' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await dbRow(created.id)).name).toBe('Prod API');
  });

  it('returns 400 for a malformed id', async () => {
    const { token } = await registerAndLogin(app);
    expect((await patch(token, 'not-a-uuid', { name: 'x' })).status).toBe(400);
  });

  it('does not lose updates when two PATCHes race', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);

    for (let i = 0; i < 10; i++) {
      const [a, b] = await Promise.all([
        patch(token, created.id, { name: `name-${i}` }),
        patch(token, created.id, { timeoutMs: 1000 + i * 1000 }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const row = await dbRow(created.id);
      expect(row.name).toBe(`name-${i}`); // both changes must survive
      expect(row.timeout_ms).toBe(1000 + i * 1000);
    }
  });
});

describe('pause and resume', () => {
  it('pause deactivates the monitor and removes it from the due set', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);

    const res = await act('post', token, created.id, '/pause');
    expect(res.status).toBe(200);
    expect(res.body.data.monitor.isActive).toBe(false);
    expect((await dbRow(created.id)).next_check_at).toBeNull();

    // Preview of the Week 3 scheduler query: a paused monitor is never due.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM monitors WHERE is_active AND next_check_at <= now()`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('pause is idempotent and does not touch updatedAt the second time', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);
    const first = await act('post', token, created.id, '/pause').expect(200);
    const second = await act('post', token, created.id, '/pause').expect(200);
    expect(second.body.data.monitor.updatedAt).toBe(first.body.data.monitor.updatedAt);
  });

  it('resume reactivates, resets stale state, and schedules an immediate check', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);
    await forceState(created.id, 'down', 2);
    await act('post', token, created.id, '/pause').expect(200);

    const res = await act('post', token, created.id, '/resume');
    expect(res.status).toBe(200);
    expect(res.body.data.monitor).toMatchObject({
      isActive: true,
      status: 'pending',
      consecutiveFailures: 0,
    });
    const row = await dbRow(created.id);
    expect(row.next_check_at <= new Date()).toBe(true);
  });

  it('resume on an active monitor is a no-op and does not wipe counters', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);
    await forceState(created.id, 'down', 2);

    const res = await act('post', token, created.id, '/resume');
    expect(res.status).toBe(200);
    expect(res.body.data.monitor.status).toBe('down');
    expect(res.body.data.monitor.consecutiveFailures).toBe(2);
  });

  it("cannot pause or resume another user's monitor", async () => {
    const alice = await registerAndLogin(app, 'alice@example.com');
    const bob = await registerAndLogin(app, 'bob@example.com');
    const created = await createMonitor(alice.token);

    expect((await act('post', bob.token, created.id, '/pause')).status).toBe(404);
    expect((await dbRow(created.id)).is_active).toBe(true);

    await act('post', alice.token, created.id, '/pause').expect(200);
    expect((await act('post', bob.token, created.id, '/resume')).status).toBe(404);
    expect((await dbRow(created.id)).is_active).toBe(false);
  });
});

describe('DELETE /api/monitors/:id', () => {
  it('deletes the monitor, returns 204, and a repeat is 404', async () => {
    const { token } = await registerAndLogin(app);
    const created = await createMonitor(token);

    await act('delete', token, created.id).expect(204);
    expect((await act('get', token, created.id)).status).toBe(404);
    expect(await dbRow(created.id)).toBeUndefined();
    expect((await act('delete', token, created.id)).status).toBe(404);
  });

  it("cannot delete another user's monitor", async () => {
    const alice = await registerAndLogin(app, 'alice@example.com');
    const bob = await registerAndLogin(app, 'bob@example.com');
    const created = await createMonitor(alice.token);

    expect((await act('delete', bob.token, created.id)).status).toBe(404);
    expect(await dbRow(created.id)).toBeDefined();
  });

  it('frees a slot in the monitor quota', async () => {
    const { token } = await registerAndLogin(app);
    const monitors = [];
    for (let i = 0; i < 3; i++) monitors.push(await createMonitor(token));
    await request(app).post('/api/monitors').set(bearer(token)).send(validBody).expect(403);

    await act('delete', token, monitors[0].id).expect(204);
    await request(app).post('/api/monitors').set(bearer(token)).send(validBody).expect(201);
  });
});