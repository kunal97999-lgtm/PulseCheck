import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();
const app = createApp();

describe('error hygiene', () => {
  it('does not advertise the framework', async () => {
    const res = await request(app).get('/health');
    expect(res.headers).not.toHaveProperty('x-powered-by');
  });

  it('returns a generic 500 that leaks no internals', async () => {
    // Simulate a database failure whose message contains infrastructure details.
    const spy = vi
      .spyOn(pool, 'query')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));

    try {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'alice@example.com', password: 'correct-horse-battery' });

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hunter2|stack|at .*\.js/);
      expect(res.body.error.requestId).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects oversized request bodies with 413', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@example.com', password: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});