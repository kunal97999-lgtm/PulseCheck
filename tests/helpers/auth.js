import request from 'supertest';

export const DEFAULT_PASSWORD = 'correct-horse-battery';

export async function registerAndLogin(app, email = 'alice@example.com', password = DEFAULT_PASSWORD) {
  await request(app).post('/api/auth/register').send({ email, password }).expect(201);
  const res = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return { token: res.body.data.token, user: res.body.data.user, password };
}