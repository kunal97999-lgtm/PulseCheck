import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { createRedisConnection } from '../../src/queues/connection.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const makeApp = (limits = {}, redis) => createApp({ rateLimits: limits, redis });
const list = (app, token) => request(app).get('/api/monitors').set(bearer(token));
const create = (app, token) =>
  request(app).post('/api/monitors').set(bearer(token)).send({ name: 'm', url: 'https://api.example.com/health' });

describe('per-user API limit', () => {
  it('allows the limit, then returns 429 with Retry-After in the standard format', async () => {
    const app = makeApp({ userApiMax: 5 });
    const { token } = await registerAndLogin(app);
    for (let i = 0; i < 5; i++) await list(app, token).expect(200);

    const res = await list(app, token);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('is per user: one user exhausting the budget does not affect another', async () => {
    const app = makeApp({ userApiMax: 3 });
    const alice = await registerAndLogin(app, 'alice@example.com');
    const bob = await registerAndLogin(app, 'bob@example.com');
    for (let i = 0; i < 3; i++) await list(app, alice.token).expect(200);
    expect((await list(app, alice.token)).status).toBe(429);
    expect((await list(app, bob.token)).status).toBe(200);
  });

  it('covers incidents and notifications too, sharing the same budget', async () => {
    const app = makeApp({ userApiMax: 3 });
    const { token } = await registerAndLogin(app);
    await list(app, token).expect(200);
    await request(app).get('/api/incidents').set(bearer(token)).expect(200);
    await request(app).get('/api/notifications').set(bearer(token)).expect(200);
    expect((await request(app).get('/api/notification-preferences').set(bearer(token))).status).toBe(429);
  });

  it('unauthenticated requests get 401 and never consume a budget or return 429', async () => {
    const app = makeApp({ userApiMax: 2 });
    for (let i = 0; i < 6; i++) {
      expect((await request(app).get('/api/monitors')).status).toBe(401);
    }
  });

  it('does not limit /health', async () => {
    const app = makeApp({ userApiMax: 1 });
    for (let i = 0; i < 5; i++) await request(app).get('/health').expect(200);
  });
});

describe('per-user write limit', () => {
  it('limits only mutating requests, and a blocked request creates nothing', async () => {
    const app = makeApp({ userApiMax: 1000, userWriteMax: 2 });
    const { token } = await registerAndLogin(app);
    await create(app, token).expect(201);
    await create(app, token).expect(201);

    const blocked = await create(app, token);
    expect(blocked.status).toBe(429);

    const res = await list(app, token); // reads are unaffected
    expect(res.status).toBe(200);
    expect(res.body.data.monitors).toHaveLength(2);
  });
});

describe('shared across API instances (Redis)', () => {
  let redis;
  let keyPrefix;
  afterEach(async () => {
    const keys = await redis.keys(`${keyPrefix}*`).catch(() => []);
    if (keys.length) await redis.del(...keys).catch(() => {});
    await redis.quit().catch(() => {});
  });

  it('two app instances count against one budget', async () => {
    redis = createRedisConnection({ forApi: true });
    keyPrefix = `rltest-${randomUUID()}`;
    const a = makeApp({ keyPrefix, userApiMax: 3 }, redis);
    const b = makeApp({ keyPrefix, userApiMax: 3 }, redis);
    const { token } = await registerAndLogin(a);

    await list(a, token).expect(200);
    await list(b, token).expect(200);
    await list(a, token).expect(200);
    expect((await list(b, token)).status).toBe(429);
    expect((await list(a, token)).status).toBe(429);
  });
});