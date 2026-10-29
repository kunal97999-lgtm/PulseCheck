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
const ok = (sec) => ({ checkedAt: at(sec), success: true, statusCode: 200, latencyMs: 40, errorType: null, errorMessage: null });
const fail = (sec) => ({
  checkedAt: at(sec), success: false, statusCode: null, latencyMs: 100,
  errorType: 'timeout', errorMessage: 'Request timed out',
});
const record = (id, slot, r) => recordCheckResult({ monitorId: id, scheduledFor: at(slot), result: r });

async function newUserWithMonitor(email, name = 'm') {
  const { token, user } = await registerAndLogin(app, email);
  const res = await request(app).post('/api/monitors').set(bearer(token))
    .send({ name, url: 'https://api.example.com/health' }).expect(201);
  return { token, userId: user.id, id: res.body.data.monitor.id };
}
const outage = async (id, base = 0) => {
  for (let i = 0; i < 3; i++) await record(id, base + i * 60, fail(base + i * 60 + 1));
};
const get = (token, path) => request(app).get(path).set(bearer(token));
const patch = (token, body) => request(app).patch('/api/notification-preferences').set(bearer(token)).send(body);

describe('authentication required', () => {
  it.each([
    ['get', '/api/notifications'],
    ['get', '/api/notification-preferences'],
    ['patch', '/api/notification-preferences'],
  ])('%s %s returns 401 without a token', async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
  });
});

describe('GET /api/notifications', () => {
  it('lists the caller\'s deliveries with no internal fields', async () => {
    const alice = await newUserWithMonitor('alice@example.com', 'Alice API');
    await outage(alice.id);
    await record(alice.id, 180, ok(181));

    const res = await get(alice.token, '/api/notifications');
    expect(res.status).toBe(200);
    const list = res.body.data.notifications;
    expect(list).toHaveLength(2);
    expect(list.map((n) => n.eventType).sort()).toEqual(['incident_opened', 'incident_resolved']);
    expect(list[0]).toMatchObject({
      channel: 'email', status: 'pending', attemptCount: 0, sentAt: null, monitorName: 'Alice API', monitorId: alice.id,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/claimed|user_?id|password/i);
  });

  it('never includes another user\'s deliveries', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    const bob = await newUserWithMonitor('bob@example.com');
    await outage(alice.id);
    await outage(bob.id);

    const a = await get(alice.token, '/api/notifications');
    const b = await get(bob.token, '/api/notifications');
    expect(a.body.data.notifications.map((n) => n.monitorId)).toEqual([alice.id]);
    expect(b.body.data.notifications.map((n) => n.monitorId)).toEqual([bob.id]);
  });

  it('filters by status and paginates', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    await outage(alice.id);
    await record(alice.id, 180, ok(181));
    await pool.query(
      `UPDATE notification_deliveries SET status = 'sent', sent_at = now() WHERE event_type = 'incident_opened'`);

    const sent = await get(alice.token, '/api/notifications?status=sent');
    const pending = await get(alice.token, '/api/notifications?status=pending');
    expect(sent.body.data.notifications.map((n) => n.eventType)).toEqual(['incident_opened']);
    expect(pending.body.data.notifications.map((n) => n.eventType)).toEqual(['incident_resolved']);

    const p1 = await get(alice.token, '/api/notifications?limit=1');
    const p2 = await get(alice.token, '/api/notifications?limit=1&offset=1');
    expect(p1.body.data.notifications).toHaveLength(1);
    expect(p2.body.data.notifications).toHaveLength(1);
    expect(p1.body.data.notifications[0].id).not.toBe(p2.body.data.notifications[0].id);
  });

  it('shows the sanitized error and attempt count for a failing delivery', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    await outage(alice.id);
    await pool.query(
      `UPDATE notification_deliveries SET attempt_count = 2, last_attempt_at = now(),
              sanitized_error_message = 'Could not reach the email provider'`);
    const [n] = (await get(alice.token, '/api/notifications')).body.data.notifications;
    expect(n).toMatchObject({ attemptCount: 2, errorMessage: 'Could not reach the email provider' });
  });

  it.each(['status=weird', 'limit=0', 'limit=101', 'offset=-1'])('rejects %s', async (qs) => {
    const { token } = await newUserWithMonitor('alice@example.com');
    expect((await get(token, `/api/notifications?${qs}`)).status).toBe(400);
  });
});

describe('notification preferences', () => {
  it('GET returns defaults when nothing was ever set, without creating a row', async () => {
    const { token } = await newUserWithMonitor('alice@example.com');
    const res = await get(token, '/api/notification-preferences');
    expect(res.body.data.preferences).toEqual({ emailOnOpen: true, emailOnResolve: true, updatedAt: null });
    expect((await pool.query('SELECT count(*)::int AS n FROM notification_preferences')).rows[0].n).toBe(0);
  });

  it('PATCH creates the row on first use; an omitted field defaults to true', async () => {
    const { token } = await newUserWithMonitor('alice@example.com');
    const res = await patch(token, { emailOnOpen: false });
    expect(res.status).toBe(200);
    expect(res.body.data.preferences).toMatchObject({ emailOnOpen: false, emailOnResolve: true });
  });

  it('PATCH merges: a later change keeps the field it did not mention', async () => {
    const { token } = await newUserWithMonitor('alice@example.com');
    await patch(token, { emailOnOpen: false }).expect(200);
    const res = await patch(token, { emailOnResolve: false });
    expect(res.body.data.preferences).toMatchObject({ emailOnOpen: false, emailOnResolve: false });
    expect((await get(token, '/api/notification-preferences')).body.data.preferences.emailOnOpen).toBe(false);
  });

  it('is per user: Bob\'s change does not touch Alice', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    const bob = await newUserWithMonitor('bob@example.com');
    await patch(bob.token, { emailOnOpen: false, emailOnResolve: false }).expect(200);
    expect((await get(alice.token, '/api/notification-preferences')).body.data.preferences)
      .toMatchObject({ emailOnOpen: true, emailOnResolve: true });
  });

  it('10 simultaneous first-time PATCHes all succeed and leave one row', async () => {
    const { token } = await newUserWithMonitor('alice@example.com');
    const outs = await Promise.all(Array.from({ length: 10 }, () => patch(token, { emailOnOpen: false })));
    expect(outs.every((r) => r.status === 200)).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM notification_preferences')).rows[0].n).toBe(1);
  });

  it.each([
    ['empty body', {}],
    ['unknown field', { emailOnOpen: true, sms: true }],
    ['userId (mass assignment)', { userId: '00000000-0000-4000-8000-000000000000' }],
    ['string instead of boolean', { emailOnOpen: 'false' }],
    ['null', { emailOnOpen: null }],
  ])('rejects: %s', async (_n, body) => {
    const { token } = await newUserWithMonitor('alice@example.com');
    const res = await patch(token, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('affects FUTURE incidents: opt out, then a new outage writes a skipped row', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    await patch(alice.token, { emailOnOpen: false }).expect(200);
    await outage(alice.id);
    const [n] = (await get(alice.token, '/api/notifications')).body.data.notifications;
    expect(n).toMatchObject({ eventType: 'incident_opened', status: 'skipped' });
  });
});