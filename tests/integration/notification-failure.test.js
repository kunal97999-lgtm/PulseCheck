import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { pool } from '../../src/db/pool.js';
import { createRedisConnection } from '../../src/queues/connection.js';
import { createNotificationQueue } from '../../src/queues/notificationQueue.js';
import { createNotificationWorker } from '../../src/workers/notificationWorker.js';
import { createNotificationProcessor } from '../../src/workers/notificationProcessor.js';
import { runNotificationSweep } from '../../src/scheduler/notificationSweeper.js';
import { sendDelivery } from '../../src/modules/notifications/sendDelivery.js';
import { createMailer } from '../../src/modules/notifications/mailer.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

let cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
  cleanups = [];
});

const mkErr = (props) => Object.assign(new Error('raw provider text'), props);
function fakeMailer(script = []) {
  const sent = [];
  let calls = 0;
  return {
    sent,
    get calls() { return calls; },
    async send(msg) {
      const step = script[calls++];
      if (step instanceof Error) throw step;
      sent.push(msg);
    },
  };
}

let n = 0;
async function seedPending({ ageSec = 600, attempts = 0, claimedSec = null, lastAttemptAgoSec = null } = {}) {
  n++;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`f${n}@example.com`]);
  const { rows: [m] } = await pool.query(
    `INSERT INTO monitors (user_id, name, url) VALUES ($1, 'Prod API', 'https://api.example.com/x') RETURNING id`, [u.id]);
  const { rows: [i] } = await pool.query(
    `INSERT INTO incidents (monitor_id, first_failed_at, started_at, failure_type, failure_reason)
     VALUES ($1, now(), now(), 'timeout', 'Request timed out') RETURNING id`, [m.id]);
  const { rows: [d] } = await pool.query(
    `INSERT INTO notification_deliveries
       (incident_id, event_type, status, attempt_count, created_at, claimed_until, last_attempt_at)
     VALUES ($1, 'incident_opened', 'pending', $2::int,
             now() - ($3::int * interval '1 second'),
             CASE WHEN $4::int IS NULL THEN NULL ELSE now() + ($4::int * interval '1 second') END,
             CASE WHEN $5::int IS NULL THEN NULL ELSE now() - ($5::int * interval '1 second') END)
     RETURNING id`,
    [i.id, attempts, ageSec, claimedSec, lastAttemptAgoSec]);
  return d.id;
}
const row = async (id) => (await pool.query('SELECT * FROM notification_deliveries WHERE id = $1', [id])).rows[0];

function realQueueAndWorker(mailer, { attempts = 5, backoffMs = 50 } = {}) {
  const prefix = `test-${randomUUID()}`;
  const conns = [createRedisConnection(), createRedisConnection({ forWorker: true })];
  const queue = createNotificationQueue({ connection: conns[0], prefix, attempts, backoffMs });
  const worker = createNotificationWorker({
    connection: conns[1], prefix, concurrency: 2,
    processor: createNotificationProcessor({ mailer, maxAttempts: 5, leaseSeconds: 60 }),
  });
  cleanups.push(
    () => worker.close(),
    () => queue.obliterate({ force: true }),
    () => queue.close(),
    () => Promise.all(conns.map((c) => c.quit())),
  );
  return { queue, worker };
}

describe('the fast path was lost: the sweeper is the guarantee', () => {
  it('an old pending row is revived through the REAL queue and sent', async () => {
    const id = await seedPending(); // committed long ago, never enqueued
    const mailer = fakeMailer();
    const { queue } = realQueueAndWorker(mailer);

    expect(await runNotificationSweep({ queue, staleSeconds: 120, maxAttempts: 5 })).toMatchObject({ enqueued: 1 });
    await vi.waitFor(async () => expect((await row(id)).status).toBe('sent'), { timeout: 8000 });
    expect(mailer.sent).toHaveLength(1);
  });

  it('sweeping twice sends one email (job-id dedupe plus the lease)', async () => {
    const id = await seedPending();
    const mailer = fakeMailer();
    const { queue } = realQueueAndWorker(mailer);

    await runNotificationSweep({ queue, staleSeconds: 120, maxAttempts: 5 });
    await runNotificationSweep({ queue, staleSeconds: 120, maxAttempts: 5 });
    await vi.waitFor(async () => expect((await row(id)).status).toBe('sent'), { timeout: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 500)); // anything extra would show up now
    expect(mailer.sent).toHaveLength(1);
  });
});

describe('the mail server is down: the queue retries, the row records why', () => {
  it('two transient failures then success: ends sent after 3 attempts', async () => {
    const id = await seedPending();
    const mailer = fakeMailer([mkErr({ code: 'ECONNECTION' }), mkErr({ responseCode: 451 })]);
    const { queue } = realQueueAndWorker(mailer);

    await queue.add('send', { deliveryId: id });
    await vi.waitFor(async () => expect((await row(id)).status).toBe('sent'), { timeout: 10000 });
    expect(await row(id)).toMatchObject({ attempt_count: 3, sanitized_error_message: null });
    expect(mailer.sent).toHaveLength(1);
  });

  it('a permanently bad recipient is failed once and never retried by the queue', async () => {
    const id = await seedPending();
    const mailer = fakeMailer(Array.from({ length: 10 }, () => mkErr({ code: 'EENVELOPE' })));
    const { queue } = realQueueAndWorker(mailer);

    await queue.add('send', { deliveryId: id });
    await vi.waitFor(async () => expect((await row(id)).status).toBe('failed'), { timeout: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mailer.calls).toBe(1);
  });

  it('a REAL nodemailer connection failure is classified as transient and leaks nothing', async () => {
    // Find a port with nothing listening on it.
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const mailer = createMailer(
      nodemailer.createTransport({ host: '127.0.0.1', port, connectionTimeout: 1000, greetingTimeout: 1000 }),
    );
    const id = await seedPending();
    const out = await sendDelivery(id, { mailer, maxAttempts: 5, leaseSeconds: 60 });

    expect(out).toEqual({ status: 'retry' });
    const r = await row(id);
    expect(r).toMatchObject({ status: 'pending', claimed_until: null });
    expect(r.sanitized_error_message).toBe('Could not reach the email provider');
    expect(r.sanitized_error_message).not.toMatch(/127\.0\.0\.1|ECONN/);
  }, 15000);
});

describe('a worker dies mid-send', () => {
  it('dies after claiming: the lease expires, the sweeper revives it, another worker sends', async () => {
    const id = await seedPending({ attempts: 1, claimedSec: -5, lastAttemptAgoSec: 300 }); // lease already expired
    const mailer = fakeMailer();
    const { queue } = realQueueAndWorker(mailer);

    expect(await runNotificationSweep({ queue, staleSeconds: 120, maxAttempts: 5 })).toMatchObject({ enqueued: 1 });
    await vi.waitFor(async () => expect((await row(id)).status).toBe('sent'), { timeout: 8000 });
    expect((await row(id)).attempt_count).toBe(2);
    expect(mailer.sent).toHaveLength(1);
  });

  it('while the lease is still active, nobody else sends', async () => {
    const id = await seedPending({ attempts: 1, claimedSec: 60, lastAttemptAgoSec: 5 });
    const mailer = fakeMailer();
    expect(await sendDelivery(id, { mailer, maxAttempts: 5, leaseSeconds: 60 })).toEqual({ status: 'not_claimed' });
    expect(mailer.calls).toBe(0);
  });

  it('DOCUMENTED LIMITATION: dying after the email was accepted but before markSent can send twice', async () => {
    const id = await seedPending({ ageSec: 10 });
    const mailer = fakeMailer();
    const original = pool.query.bind(pool);
    const spy = vi.spyOn(pool, 'query').mockImplementation((...args) =>
      typeof args[0] === 'string' && args[0].includes("status = 'sent'")
        ? Promise.reject(new Error('process died before markSent committed'))
        : original(...args),
    );
    try {
      await expect(sendDelivery(id, { mailer, maxAttempts: 5, leaseSeconds: 60 })).rejects.toThrow('died');
    } finally {
      spy.mockRestore();
    }
    expect(mailer.sent).toHaveLength(1); // the provider accepted it
    expect((await row(id)).status).toBe('pending'); // but we never recorded that

    await pool.query(`UPDATE notification_deliveries SET claimed_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect((await sendDelivery(id, { mailer, maxAttempts: 5, leaseSeconds: 60 })).status).toBe('sent');
    expect(mailer.sent).toHaveLength(2); // the duplicate email: at-least-once, stated honestly
  });
});

describe('preferences changed after the row was written', () => {
  it('an already-pending delivery is still sent (decision made at write time)', async () => {
    const id = await seedPending({ ageSec: 10 });
    const { rows: [u] } = await pool.query(
      `SELECT m.user_id FROM notification_deliveries d JOIN incidents i ON i.id = d.incident_id
         JOIN monitors m ON m.id = i.monitor_id WHERE d.id = $1`, [id]);
    await pool.query(
      `INSERT INTO notification_preferences (user_id, email_on_open, email_on_resolve) VALUES ($1, false, false)`, [u.user_id]);

    const mailer = fakeMailer();
    expect((await sendDelivery(id, { mailer, maxAttempts: 5, leaseSeconds: 60 })).status).toBe('sent');
  });
});