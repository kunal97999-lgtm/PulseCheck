import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestDb } from '../helpers/db.js';
import { DEFAULT_PASSWORD } from '../helpers/auth.js';

useTestDb();

const credentials = { email: 'alice@example.com', password: DEFAULT_PASSWORD };
const wrong = { ...credentials, password: 'wrong-password-here' };

// A new app per test gives each test fresh, isolated counters.
const makeApp = (overrides) => createApp({ rateLimits: overrides });

describe('auth rate limiting', () => {
  it('blocks login after the failure limit, even with the correct password', async () => {
    const app = makeApp({ loginMaxFailures: 3 });
    await request(app).post('/api/auth/register').send(credentials).expect(201);

    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/auth/login').send(wrong).expect(401);
    }

    const blocked = await request(app).post('/api/auth/login').send(credentials);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body.error.requestId).toBeTruthy();
  });

  it('does not count successful logins against the limit', async () => {
    const app = makeApp({ loginMaxFailures: 3 });
    await request(app).post('/api/auth/register').send(credentials).expect(201);

    for (let i = 0; i < 6; i++) {
      await request(app).post('/api/auth/login').send(credentials).expect(200);
    }
    // Budget is untouched: a failure is still a normal 401, not a 429.
    await request(app).post('/api/auth/login').send(wrong).expect(401);
  });

  it('limits registrations per window', async () => {
    const app = makeApp({ registerMax: 2 });
    await request(app).post('/api/auth/register').send({ ...credentials, email: 'a@example.com' }).expect(201);
    await request(app).post('/api/auth/register').send({ ...credentials, email: 'b@example.com' }).expect(201);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...credentials, email: 'c@example.com' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});