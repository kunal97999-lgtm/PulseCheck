import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin, DEFAULT_PASSWORD } from '../helpers/auth.js';

useTestDb();
const app = createApp();

const credentials = { email: 'alice@example.com', password: DEFAULT_PASSWORD };
const withoutRequestId = (body) => ({ error: { ...body.error, requestId: undefined } });

describe('POST /api/auth/register', () => {
  it('creates a user, lowercases the email, and returns no credentials', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...credentials, email: 'Alice@Example.com' });

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('alice@example.com');
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });

  it('stores a bcrypt hash, never the plaintext password', async () => {
    await request(app).post('/api/auth/register').send(credentials).expect(201);
    const { rows } = await pool.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/);
    expect(rows[0].password_hash).not.toContain(DEFAULT_PASSWORD);
  });

  it('rejects a duplicate email, including a different-case variant', async () => {
    await request(app).post('/api/auth/register').send(credentials).expect(201);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...credentials, email: 'ALICE@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('allows exactly one winner when the same email registers concurrently', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post('/api/auth/register').send(credentials)),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(1);
  });

  it('returns per-field validation details', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = res.body.error.details.map((d) => d.field).sort();
    expect(fields).toEqual(['email', 'password']);
  });

  it('rejects malformed JSON with the standard error format', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('includes a requestId that matches the X-Request-Id header', async () => {
    const res = await request(app).post('/api/auth/register').send({});
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('POST /api/auth/login', () => {
  it('returns a 43-character token and forbids caching', async () => {
    await request(app).post('/api/auth/register').send(credentials).expect(201);
    const res = await request(app).post('/api/auth/login').send(credentials);
    expect(res.status).toBe(200);
    expect(res.body.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('accepts the email in a different case', async () => {
    await request(app).post('/api/auth/register').send(credentials).expect(201);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ ...credentials, email: 'ALICE@EXAMPLE.COM' });
    expect(res.status).toBe(200);
  });

  it('gives identical responses for a wrong password and an unknown email', async () => {
    await request(app).post('/api/auth/register').send(credentials).expect(201);
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ ...credentials, password: 'wrong-password-here' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password-here' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(withoutRequestId(wrongPassword.body)).toEqual(withoutRequestId(unknownEmail.body));
  });
});

describe('GET /api/auth/me and POST /api/auth/logout', () => {
  it('returns the current user for a valid token', async () => {
    const { token } = await registerAndLogin(app);
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('alice@example.com');
  });

  it.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic abc'],
    ['malformed token', 'Bearer abc'],
    ['well-formed but unknown token', `Bearer ${'a'.repeat(43)}`],
  ])('returns 401 for %s', async (_name, header) => {
    const req = request(app).get('/api/auth/me');
    if (header) req.set('Authorization', header);
    const res = await req;
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an expired session', async () => {
    const { token } = await registerAndLogin(app);
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('invalidates the token immediately on logout', async () => {
    const { token } = await registerAndLogin(app);
    const auth = { Authorization: `Bearer ${token}` };

    await request(app).post('/api/auth/logout').set(auth).expect(204);
    const res = await request(app).get('/api/auth/me').set(auth);
    expect(res.status).toBe(401);
  });

  it('keeps other sessions of the same user alive after logout', async () => {
    const first = await registerAndLogin(app);
    const second = await request(app).post('/api/auth/login').send(credentials).expect(200);
    const secondToken = second.body.data.token;

    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${first.token}`)
      .expect(204);

    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${secondToken}`)
      .expect(200);
  });

  it('stores only a hash of the token', async () => {
    const { token } = await registerAndLogin(app);
    const { rows } = await pool.query('SELECT token_hash FROM sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toHaveLength(64);
  });

  it('deletes sessions when the user is deleted (ON DELETE CASCADE)', async () => {
    const { user } = await registerAndLogin(app);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM sessions');
    expect(rows[0].n).toBe(0);
  });
});