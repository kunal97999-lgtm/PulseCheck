import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

const wrong = { email: 'nobody@example.com', password: 'wrong-password-here' };
const fail = (app, forwardedFor) => {
  const r = request(app).post('/api/auth/login').send(wrong);
  return forwardedFor ? r.set('X-Forwarded-For', forwardedFor) : r;
};

describe('trust proxy', () => {
  it('with 0 hops, X-Forwarded-For is ignored: a client cannot dodge the limit by changing it', async () => {
    const app = createApp({ rateLimits: { loginMaxFailures: 3 }, trustProxyHops: 0 });
    await fail(app, '1.1.1.1').expect(401);
    await fail(app, '2.2.2.2').expect(401);
    await fail(app, '3.3.3.3').expect(401);
    expect((await fail(app, '4.4.4.4')).status).toBe(429); // same socket IP, so one shared budget
  });

  it('with 1 hop, the proxy-supplied client address is used: different clients, separate budgets', async () => {
    const app = createApp({ rateLimits: { loginMaxFailures: 2 }, trustProxyHops: 1 });
    await fail(app, '1.1.1.1').expect(401);
    await fail(app, '1.1.1.1').expect(401);
    expect((await fail(app, '1.1.1.1')).status).toBe(429); // client A is blocked
    expect((await fail(app, '2.2.2.2')).status).toBe(401); // client B is not
  });

  it('with 1 hop, a client-forged leading entry does not help: only the last hop is trusted', async () => {
    const app = createApp({ rateLimits: { loginMaxFailures: 2 }, trustProxyHops: 1 });
    // The proxy appends the real client address LAST. Anything before it is attacker-controlled.
    await fail(app, '9.9.9.1, 5.5.5.5').expect(401);
    await fail(app, '9.9.9.2, 5.5.5.5').expect(401);
    expect((await fail(app, '9.9.9.3, 5.5.5.5')).status).toBe(429); // still counted as 5.5.5.5
  });
});