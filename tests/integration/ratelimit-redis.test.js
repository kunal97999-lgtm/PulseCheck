import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { createRedisConnection } from '../../src/queues/connection.js';
import { useTestDb } from '../helpers/db.js';
import { DEFAULT_PASSWORD } from '../helpers/auth.js';

useTestDb();

let redis;
let keyPrefix;

function setup() {
  redis = createRedisConnection({ forApi: true });
  keyPrefix = `rltest-${randomUUID()}`;
}
// Each call is a separate "API instance" sharing one Redis and one key prefix.
const makeApp = (limits = {}) => createApp({ rateLimits: { ...limits, keyPrefix }, redis });

afterEach(async () => {
  const keys = await redis.keys(`${keyPrefix}*`).catch(() => []);
  if (keys.length) await redis.del(...keys).catch(() => {});
  await redis.quit().catch(() => {});
});

const wrong = { email: 'nobody@example.com', password: 'wrong-password-here' };
const fail = (app) => request(app).post('/api/auth/login').send(wrong);

describe('Redis-backed login limiter', () => {
  it('blocks after the failure limit with 429 and Retry-After', async () => {
    setup();
    const app = makeApp({ loginMaxFailures: 3 });
    for (let i = 0; i < 3; i++) await fail(app).expect(401);

    const res = await fail(app);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('is shared across API instances', async () => {
    setup();
    const instanceA = makeApp({ loginMaxFailures: 3 });
    const instanceB = makeApp({ loginMaxFailures: 3 });

    await fail(instanceA).expect(401);
    await fail(instanceA).expect(401);
    await fail(instanceB).expect(401); // third failure, on a DIFFERENT instance

    expect((await fail(instanceA)).status).toBe(429);
    expect((await fail(instanceB)).status).toBe(429);
  });

  it('survives an API restart (a brand-new app instance still remembers)', async () => {
    setup();
    const before = makeApp({ loginMaxFailures: 3 });
    for (let i = 0; i < 3; i++) await fail(before).expect(401);

    const afterRestart = makeApp({ loginMaxFailures: 3 }); // fresh process, same Redis
    expect((await fail(afterRestart)).status).toBe(429);
  });

  it('stores counters with a TTL no longer than the window', async () => {
    setup();
    const app = makeApp({ loginMaxFailures: 3, loginWindowMs: 60_000 });
    await fail(app).expect(401);

    const keys = await redis.keys(`${keyPrefix}:login:*`);
    expect(keys.length).toBeGreaterThan(0);
    const ttl = await redis.pttl(keys[0]);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('does not count successful logins', async () => {
    setup();
    const app = makeApp({ loginMaxFailures: 3 });
    const creds = { email: 'alice@example.com', password: DEFAULT_PASSWORD };
    await request(app).post('/api/auth/register').send(creds).expect(201);

    for (let i = 0; i < 6; i++) await request(app).post('/api/auth/login').send(creds).expect(200);
    await fail(app).expect(401); // budget untouched: a failure is still a normal 401
  });

  it('login and register budgets are separate (no key collision)', async () => {
    setup();
    const app = makeApp({ loginMaxFailures: 2, registerMax: 5 });
    await fail(app).expect(401);
    await fail(app).expect(401);
    expect((await fail(app)).status).toBe(429);

    // Registration is a different limiter and is unaffected.
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', password: DEFAULT_PASSWORD })
      .expect(201);
  });
});

describe('when Redis is unavailable', () => {
  it('fails OPEN: the request is served, not turned into a 500 or a hang', async () => {
    setup();
    const app = makeApp({ loginMaxFailures: 1 });
    await fail(app).expect(401); // proves the store worked while Redis was up

    redis.disconnect(); // Redis "goes away" without the app being told

    const started = Date.now();
    const res = await fail(app);
    expect(res.status).toBe(401); // reached the login handler; the limiter let it through
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('/ready', () => {
  it('is 200 with Postgres and Redis up, 503 once Redis is gone, with no details', async () => {
    setup();
    const app = makeApp();
    expect((await request(app).get('/ready')).status).toBe(200);

    redis.disconnect();

    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready' });
    // Liveness must not depend on Redis.
    expect((await request(app).get('/health')).status).toBe(200);
  });
});