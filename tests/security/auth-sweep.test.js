import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();
const app = createApp();
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const id = randomUUID();

// Every route that requires a session. Add new routes here.
const PROTECTED = [
  ['get', '/api/auth/me'],
  ['post', '/api/auth/logout'],
  ['get', '/api/monitors'],
  ['post', '/api/monitors'],
  ['get', `/api/monitors/${id}`],
  ['patch', `/api/monitors/${id}`],
  ['delete', `/api/monitors/${id}`],
  ['post', `/api/monitors/${id}/pause`],
  ['post', `/api/monitors/${id}/resume`],
  ['get', `/api/monitors/${id}/checks`],
  ['get', `/api/monitors/${id}/stats`],
  ['get', `/api/monitors/${id}/incidents`],
  ['get', '/api/incidents'],
  ['get', `/api/incidents/${id}`],
  ['get', '/api/notifications'],
  ['get', '/api/notification-preferences'],
  ['patch', '/api/notification-preferences'],
];

describe('every protected route requires authentication', () => {
  it.each(PROTECTED)('%s %s -> 401 without a token', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js:\d+|node_modules/); // no stack traces
  });

  it.each(PROTECTED)('%s %s -> 401 with a garbage token', async (method, path) => {
    const res = await request(app)[method](path).set(bearer('x'.repeat(43))).send({});
    expect(res.status).toBe(401);
  });

  it('unknown routes return the standard 404, with a request id', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body.error.requestId).toBeTruthy();
  });
});

describe("no route lets one user touch another user's monitor", () => {
  it("Bob gets 404 on every operation against Alice's monitor, and nothing changes", async () => {
    const alice = await registerAndLogin(app, 'alice@example.com');
    const bob = await registerAndLogin(app, 'bob@example.com');
    const created = await request(app).post('/api/monitors').set(bearer(alice.token))
      .send({ name: 'Alice only', url: 'https://api.example.com/health' }).expect(201);
    const mid = created.body.data.monitor.id;

    const attacks = [
      ['get', `/api/monitors/${mid}`, undefined],
      ['patch', `/api/monitors/${mid}`, { name: 'hacked' }],
      ['post', `/api/monitors/${mid}/pause`, undefined],
      ['post', `/api/monitors/${mid}/resume`, undefined],
      ['get', `/api/monitors/${mid}/checks`, undefined],
      ['get', `/api/monitors/${mid}/stats`, undefined],
      ['get', `/api/monitors/${mid}/incidents`, undefined],
      ['delete', `/api/monitors/${mid}`, undefined],
    ];
    for (const [method, path, body] of attacks) {
      const res = await request(app)[method](path).set(bearer(bob.token)).send(body);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(404);
    }

    const after = await request(app).get(`/api/monitors/${mid}`).set(bearer(alice.token));
    expect(after.status).toBe(200);
    expect(after.body.data.monitor).toMatchObject({ name: 'Alice only', isActive: true });
  });
});