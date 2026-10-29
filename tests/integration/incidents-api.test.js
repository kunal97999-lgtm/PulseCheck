import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { recordCheckResult } from '../../src/modules/checks/checkResults.service.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();
const app = createApp();

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const at = (sec) => new Date(T0 + sec * 1000);
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const withoutRequestId = (b) => ({ error: { ...b.error, requestId: undefined } });

const ok = (sec) => ({ checkedAt: at(sec), success: true, statusCode: 200, latencyMs: 40, errorType: null, errorMessage: null });
const fail = (sec) => ({
  checkedAt: at(sec), success: false, statusCode: null, latencyMs: 100,
  errorType: 'timeout', errorMessage: 'Request timed out',
});
const record = (id, slot, result) => recordCheckResult({ monitorId: id, scheduledFor: at(slot), result });

async function newUserWithMonitor(email, name = 'm') {
  const { token } = await registerAndLogin(app, email);
  const res = await request(app).post('/api/monitors').set(bearer(token))
    .send({ name, url: 'https://api.example.com/health' }).expect(201);
  return { token, id: res.body.data.monitor.id };
}
// Three failures open an incident at base+121s; the success at base+181s resolves it (60s long).
const openOutage = async (id, base) => {
  for (let i = 0; i < 3; i++) await record(id, base + i * 60, fail(base + i * 60 + 1));
};
const cycle = async (id, base) => {
  await openOutage(id, base);
  await record(id, base + 180, ok(base + 181));
};

describe('authentication required', () => {
  it.each([
    ['/api/incidents'],
    [`/api/incidents/${randomUUID()}`],
    [`/api/monitors/${randomUUID()}/incidents`],
  ])('GET %s returns 401 without a token', async (path) => {
    expect((await request(app).get(path)).status).toBe(401);
  });
});

describe('GET /api/incidents', () => {
  it('lists the caller\'s incidents newest first, with durations and no internal fields', async () => {
    const alice = await newUserWithMonitor('alice@example.com', 'Alice API');
    await cycle(alice.id, 0); // resolved
    await openOutage(alice.id, 1000); // open, newer

    const res = await request(app).get('/api/incidents').set(bearer(alice.token));
    expect(res.status).toBe(200);
    const [newest, older] = res.body.data.incidents;

    expect(newest).toMatchObject({ status: 'open', resolvedAt: null, resolutionReason: null, monitorName: 'Alice API', monitorId: alice.id });
    expect(newest.durationSeconds).toBeGreaterThan(0); // still running: measured to now
    expect(older).toMatchObject({
      status: 'resolved', resolutionReason: 'recovered', failureType: 'timeout',
      failureReason: 'Request timed out', durationSeconds: 60,
    });
    expect(new Date(older.firstFailedAt) < new Date(older.startedAt)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/user_?id/i);
  });

  it('never includes another user\'s incidents', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    const bob = await newUserWithMonitor('bob@example.com');
    await cycle(alice.id, 0);
    await cycle(bob.id, 0);

    const a = await request(app).get('/api/incidents').set(bearer(alice.token));
    const b = await request(app).get('/api/incidents').set(bearer(bob.token));
    expect(a.body.data.incidents.map((i) => i.monitorId)).toEqual([alice.id]);
    expect(b.body.data.incidents.map((i) => i.monitorId)).toEqual([bob.id]);
  });

  it('filters by status, and a foreign monitorId filter yields an empty list, not a leak', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    const bob = await newUserWithMonitor('bob@example.com');
    await cycle(alice.id, 0);
    await openOutage(alice.id, 1000);
    await cycle(bob.id, 0);

    const open = await request(app).get('/api/incidents?status=open').set(bearer(alice.token));
    const resolved = await request(app).get('/api/incidents?status=resolved').set(bearer(alice.token));
    expect(open.body.data.incidents.map((i) => i.status)).toEqual(['open']);
    expect(resolved.body.data.incidents.map((i) => i.status)).toEqual(['resolved']);

    const foreign = await request(app).get(`/api/incidents?monitorId=${bob.id}`).set(bearer(alice.token));
    expect(foreign.status).toBe(200);
    expect(foreign.body.data.incidents).toEqual([]);
  });

  it.each(['status=weird', 'limit=0', 'limit=101', 'offset=-1', 'monitorId=nope'])('rejects %s', async (qs) => {
    const { token } = await newUserWithMonitor('alice@example.com');
    expect((await request(app).get(`/api/incidents?${qs}`).set(bearer(token))).status).toBe(400);
  });
});

describe('GET /api/incidents/:id', () => {
  it('returns the owner\'s incident', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    await cycle(alice.id, 0);
    const list = await request(app).get('/api/incidents').set(bearer(alice.token));
    const id = list.body.data.incidents[0].id;

    const res = await request(app).get(`/api/incidents/${id}`).set(bearer(alice.token));
    expect(res.status).toBe(200);
    expect(res.body.data.incident.id).toBe(id);
  });

  it('returns 404 for another user\'s incident, identical to a nonexistent one', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    const bob = await newUserWithMonitor('bob@example.com');
    await cycle(alice.id, 0);
    const id = (await request(app).get('/api/incidents').set(bearer(alice.token))).body.data.incidents[0].id;

    const cross = await request(app).get(`/api/incidents/${id}`).set(bearer(bob.token));
    const missing = await request(app).get(`/api/incidents/${randomUUID()}`).set(bearer(bob.token));
    expect(cross.status).toBe(404);
    expect(withoutRequestId(cross.body)).toEqual(withoutRequestId(missing.body));
  });

  it('returns 400 for a malformed id instead of a 500', async () => {
    const { token } = await newUserWithMonitor('alice@example.com');
    expect((await request(app).get('/api/incidents/not-a-uuid').set(bearer(token))).status).toBe(400);
  });
});

describe('GET /api/monitors/:id/incidents', () => {
  it('lists one monitor\'s incidents with pagination, newest first', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    for (const base of [0, 1000, 2000]) await cycle(alice.id, base);

    const p1 = await request(app).get(`/api/monitors/${alice.id}/incidents?limit=2`).set(bearer(alice.token));
    const p2 = await request(app).get(`/api/monitors/${alice.id}/incidents?limit=2&offset=2`).set(bearer(alice.token));
    expect(p1.body.data.incidents).toHaveLength(2);
    expect(p2.body.data.incidents).toHaveLength(1);
    const started = [...p1.body.data.incidents, ...p2.body.data.incidents].map((i) => i.startedAt);
    expect(started).toEqual([...started].sort().reverse());
    expect(p1.body.meta).toEqual({ limit: 2, offset: 0 });
  });

  it('returns an empty list for the owner\'s monitor that has no incidents', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    const res = await request(app).get(`/api/monitors/${alice.id}/incidents`).set(bearer(alice.token));
    expect(res.status).toBe(200);
    expect(res.body.data.incidents).toEqual([]);
  });

  it('returns 404 for another user\'s monitor and for a nonexistent one, identically', async () => {
    const alice = await newUserWithMonitor('alice@example.com');
    const bob = await newUserWithMonitor('bob@example.com');
    await cycle(alice.id, 0);

    const cross = await request(app).get(`/api/monitors/${alice.id}/incidents`).set(bearer(bob.token));
    const missing = await request(app).get(`/api/monitors/${randomUUID()}/incidents`).set(bearer(bob.token));
    expect(cross.status).toBe(404);
    expect(withoutRequestId(cross.body)).toEqual(withoutRequestId(missing.body));
  });
});