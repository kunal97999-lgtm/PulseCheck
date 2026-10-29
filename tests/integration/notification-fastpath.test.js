import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { pool } from '../../src/db/pool.js';
import { createCheckProcessor } from '../../src/workers/processors.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

let server;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
});

async function failingMonitor(email) {
  server = http.createServer((req, res) => { res.statusCode = 503; res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const policy = { isBlockedIp: () => false, allowedPorts: new Set(['', String(port)]) };
  const { rows: [u] } = await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [email]);
  const { rows: [m] } = await pool.query(
    `INSERT INTO monitors (user_id, name, url, timeout_ms, failure_threshold) VALUES ($1, 'm', $2, 3000, 1) RETURNING id`,
    [u.id, `http://127.0.0.1:${port}/`]);
  return { monitorId: m.id, userId: u.id, policy };
}
const jobFor = (monitorId) => ({ id: 'j', attemptsMade: 0, data: { monitorId, scheduledFor: '2026-01-01T00:00:00.000Z' } });

describe('enqueueing after the commit', () => {
  it('enqueues the delivery id for a pending notification', async () => {
    const { monitorId, policy } = await failingMonitor('a@example.com');
    const calls = [];
    const notificationQueue = { add: async (...args) => calls.push(args) };

    await createCheckProcessor({ policy, notificationQueue })(jobFor(monitorId));

    const { rows: [d] } = await pool.query('SELECT id FROM notification_deliveries');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ deliveryId: d.id });
    expect(calls[0][2]).toEqual({ jobId: d.id });
  });

  it('a notification-queue outage does not fail the check job, and the row stays pending', async () => {
    const { monitorId, policy } = await failingMonitor('b@example.com');
    const notificationQueue = { add: async () => { throw new Error('redis is down'); } };

    await expect(createCheckProcessor({ policy, notificationQueue })(jobFor(monitorId))).resolves.toEqual({ status: 'recorded' });

    const { rows } = await pool.query('SELECT status FROM notification_deliveries');
    expect(rows).toEqual([{ status: 'pending' }]); // the sweeper will find it
    expect((await pool.query('SELECT count(*)::int AS n FROM check_results')).rows[0].n).toBe(1);
  });

  it('does not enqueue a skipped (opted-out) notification', async () => {
    const { monitorId, userId, policy } = await failingMonitor('c@example.com');
    await pool.query(`INSERT INTO notification_preferences (user_id, email_on_open) VALUES ($1, false)`, [userId]);
    const calls = [];
    await createCheckProcessor({ policy, notificationQueue: { add: async (...a) => calls.push(a) } })(jobFor(monitorId));
    expect(calls).toHaveLength(0);
  });
});