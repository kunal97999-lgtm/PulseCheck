import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();

const TOKEN = 'a'.repeat(43);
const fake = (status) => async () => ({ status, reasons: status === 'ok' ? [] : ['x'], workers: { live: 1 } });
const makeApp = ({ status = 'ok', limits = {}, token = TOKEN } = {}) =>
  createApp({ rateLimits: limits, ops: token ? { token, collect: fake(status) } : undefined });
const get = (app, authorization) => {
  const r = request(app).get('/ops/status');
  return authorization ? r.set('Authorization', authorization) : r;
};
const withoutRequestId = (b) => ({ error: { ...b.error, requestId: undefined } });

describe('/ops/status', () => {
  it('does not exist when OPS_TOKEN is not configured (plain 404)', async () => {
    const res = await get(makeApp({ token: null }), `Bearer ${TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 200 with the right token and forbids caching', async () => {
    const res = await get(makeApp(), `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 200 for degraded and 503 for down', async () => {
    expect((await get(makeApp({ status: 'degraded' }), `Bearer ${TOKEN}`)).status).toBe(200);
    expect((await get(makeApp({ status: 'down' }), `Bearer ${TOKEN}`)).status).toBe(503);
  });

  it.each([
    ['no header', undefined],
    ['wrong scheme', `Basic ${TOKEN}`],
    ['wrong token', `Bearer ${'b'.repeat(43)}`],
    ['almost right (one char short)', `Bearer ${TOKEN.slice(0, -1)}`],
    ['almost right (one char long)', `Bearer ${TOKEN}x`],
    ['empty bearer', 'Bearer '],
  ])('returns an identical 401 for: %s', async (_n, header) => {
    const app = makeApp();
    const res = await get(app, header);
    expect(res.status).toBe(401);
    const ref = await get(app, 'Bearer nope');
    expect(withoutRequestId(res.body)).toEqual(withoutRequestId(ref.body));
  });

  it('a valid USER session token is not an ops token', async () => {
    const app = makeApp();
    const { token } = await registerAndLogin(app);
    expect((await get(app, `Bearer ${token}`)).status).toBe(401);
  });

  it('locks an IP out after repeated failed attempts, even for the right token', async () => {
    const app = makeApp({ limits: { opsMaxFailures: 3 } });
    for (let i = 0; i < 3; i++) await get(app, 'Bearer wrong').expect(401);
    const res = await get(app, `Bearer ${TOKEN}`);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('a monitoring tool polling a DOWN system is never rate limited (503 is not a failed attempt)', async () => {
    const app = makeApp({ status: 'down', limits: { opsMaxFailures: 3 } });
    for (let i = 0; i < 8; i++) {
      expect((await get(app, `Bearer ${TOKEN}`)).status).toBe(503);
    }
  });

  it('successful polls do not use up the failure budget', async () => {
    const app = makeApp({ limits: { opsMaxFailures: 2 } });
    for (let i = 0; i < 6; i++) await get(app, `Bearer ${TOKEN}`).expect(200);
    await get(app, 'Bearer wrong').expect(401);
  });
});