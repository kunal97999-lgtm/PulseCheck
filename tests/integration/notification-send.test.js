import { describe, it, expect } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { pool } from '../../src/db/pool.js';
import { sendDelivery } from '../../src/modules/notifications/sendDelivery.js';
import { createNotificationProcessor } from '../../src/workers/notificationProcessor.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

const opts = (mailer, over = {}) => ({ mailer, maxAttempts: 5, leaseSeconds: 60, ...over });
const mkErr = (props, message = 'boom') => Object.assign(new Error(message), props);

// script: one entry per call. An Error is thrown, anything else succeeds. Beyond the script: success.
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
const always = (e) => Array.from({ length: 20 }, () => e);

async function seed({
  eventType = 'incident_opened', status = 'pending', email = 'owner@example.com',
  name = 'Prod API', url = 'https://api.example.com/health',
} = {}) {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [email]);
  const { rows: [m] } = await pool.query(
    `INSERT INTO monitors (user_id, name, url) VALUES ($1, $2, $3) RETURNING id`, [u.id, name, url]);
  const resolved = eventType === 'incident_resolved';
  const { rows: [i] } = await pool.query(
    `INSERT INTO incidents (monitor_id, status, first_failed_at, started_at, resolved_at, resolution_reason,
                            failure_type, failure_reason)
     VALUES ($1, $2::text, now() - interval '5 minutes', now() - interval '4 minutes',
             CASE WHEN $2::text = 'resolved' THEN now() END,
             CASE WHEN $2::text = 'resolved' THEN 'recovered' END,
             'timeout', 'Request timed out')
     RETURNING id`,
    [m.id, resolved ? 'resolved' : 'open']);
  const { rows: [d] } = await pool.query(
    `INSERT INTO notification_deliveries (incident_id, event_type, status, sent_at)
     VALUES ($1, $2::text, $3::text, CASE WHEN $3::text = 'sent' THEN now() END) RETURNING id`,
    [i.id, eventType, status]);
  return { deliveryId: d.id, incidentId: i.id, monitorId: m.id };
}
const row = async (id) =>
  (await pool.query('SELECT * FROM notification_deliveries WHERE id = $1', [id])).rows[0];

describe('a successful send', () => {
  it('emails the monitor owner and marks the row sent', async () => {
    const { deliveryId } = await seed();
    const mailer = fakeMailer();
    expect(await sendDelivery(deliveryId, opts(mailer))).toEqual({ status: 'sent' });

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('owner@example.com');
    expect(mailer.sent[0].subject).toBe('[PulseCheck] DOWN: Prod API');
    expect(await row(deliveryId)).toMatchObject({
      status: 'sent', attempt_count: 1, claimed_until: null, sanitized_error_message: null,
    });
    expect((await row(deliveryId)).sent_at).toBeInstanceOf(Date);
  });

  it('sends a recovery email for incident_resolved', async () => {
    const { deliveryId } = await seed({ eventType: 'incident_resolved' });
    const mailer = fakeMailer();
    await sendDelivery(deliveryId, opts(mailer));
    expect(mailer.sent[0].subject).toBe('[PulseCheck] RECOVERED: Prod API');
  });

  it('leaks no URL path or query into the email, and no header injection from the name', async () => {
    const { deliveryId } = await seed({
      url: 'https://api.example.com/hook/SECRET?token=abc', name: 'x\r\nBcc: evil@example.com',
    });
    const mailer = fakeMailer();
    await sendDelivery(deliveryId, opts(mailer));
    expect(mailer.sent[0].text).not.toMatch(/SECRET|token=abc/);
    expect(mailer.sent[0].subject).not.toMatch(/[\r\n]/);
  });
});

describe('rows that must not be sent', () => {
  it.each([['skipped'], ['sent'], ['failed']])('a %s row is never emailed', async (status) => {
    const { deliveryId } = await seed({ status });
    const mailer = fakeMailer();
    expect(await sendDelivery(deliveryId, opts(mailer))).toEqual({ status: 'not_claimed' });
    expect(mailer.calls).toBe(0);
  });

  it('a second delivery of the same job sends nothing', async () => {
    const { deliveryId } = await seed();
    const mailer = fakeMailer();
    await sendDelivery(deliveryId, opts(mailer));
    expect(await sendDelivery(deliveryId, opts(mailer))).toEqual({ status: 'not_claimed' });
    expect(mailer.sent).toHaveLength(1);
  });

  it('5 concurrent attempts send exactly one email (the lease)', async () => {
    const { deliveryId } = await seed();
    const mailer = fakeMailer();
    const outs = await Promise.all(Array.from({ length: 5 }, () => sendDelivery(deliveryId, opts(mailer))));
    expect(outs.filter((o) => o.status === 'sent')).toHaveLength(1);
    expect(outs.filter((o) => o.status === 'not_claimed')).toHaveLength(4);
    expect(mailer.sent).toHaveLength(1);
  });

  it('an active lease blocks a claim; an expired one allows it', async () => {
    const { deliveryId } = await seed();
    await pool.query(`UPDATE notification_deliveries SET claimed_until = now() + interval '1 minute' WHERE id = $1`, [deliveryId]);
    const mailer = fakeMailer();
    expect((await sendDelivery(deliveryId, opts(mailer))).status).toBe('not_claimed');

    await pool.query(`UPDATE notification_deliveries SET claimed_until = now() - interval '1 second' WHERE id = $1`, [deliveryId]);
    expect((await sendDelivery(deliveryId, opts(mailer))).status).toBe('sent');
  });
});

describe('transient failures', () => {
  it.each([
    ['connection error', { code: 'ECONNECTION' }],
    ['4xx from the provider', { responseCode: 451 }],
    ['unknown error', {}],
  ])('%s: stays pending with the lease released, then succeeds on retry', async (_n, props) => {
    const { deliveryId } = await seed();
    const mailer = fakeMailer([mkErr(props)]);

    expect(await sendDelivery(deliveryId, opts(mailer))).toEqual({ status: 'retry' });
    expect(await row(deliveryId)).toMatchObject({ status: 'pending', attempt_count: 1, claimed_until: null });
    expect((await row(deliveryId)).sanitized_error_message).toBeTruthy();

    expect(await sendDelivery(deliveryId, opts(mailer))).toEqual({ status: 'sent' });
    expect(await row(deliveryId)).toMatchObject({ status: 'sent', attempt_count: 2, sanitized_error_message: null });
  });

  it('gives up on the last attempt and records why', async () => {
    const { deliveryId } = await seed();
    const mailer = fakeMailer(always(mkErr({ code: 'ETIMEDOUT' })));
    const o = opts(mailer, { maxAttempts: 3 });

    expect((await sendDelivery(deliveryId, o)).status).toBe('retry');
    expect((await sendDelivery(deliveryId, o)).status).toBe('retry');
    expect((await sendDelivery(deliveryId, o)).status).toBe('failed');

    const r = await row(deliveryId);
    expect(r).toMatchObject({ status: 'failed', attempt_count: 3 });
    expect(r.sanitized_error_message).toContain('gave up after 3 attempts');
    expect(await sendDelivery(deliveryId, o)).toEqual({ status: 'not_claimed' }); // finished: no more tries
    expect(mailer.calls).toBe(3);
  });
});

describe('permanent failures and bad recipients', () => {
  it.each([
    ['invalid recipient', { code: 'EENVELOPE' }, 'Recipient address was rejected'],
    ['550 rejected', { responseCode: 550 }, 'Email provider rejected the message'],
  ])('%s: failed immediately, no retry', async (_n, props, message) => {
    const { deliveryId } = await seed();
    const mailer = fakeMailer(always(mkErr(props)));
    expect(await sendDelivery(deliveryId, opts(mailer))).toEqual({ status: 'failed' });
    expect(await row(deliveryId)).toMatchObject({ status: 'failed', attempt_count: 1, sanitized_error_message: message });
    expect(mailer.calls).toBe(1);
  });

  it('never stores the raw provider error (it contains the recipient)', async () => {
    const { deliveryId } = await seed({ email: 'alice@example.com' });
    const mailer = fakeMailer([mkErr({ code: 'EENVELOPE' }, 'No recipients defined: alice@example.com <550 5.1.1>')]);
    await sendDelivery(deliveryId, opts(mailer));
    expect((await row(deliveryId)).sanitized_error_message).not.toMatch(/alice|550 5\.1\.1/);
  });
});

describe('the queue processor', () => {
  const job = (data) => ({ id: 'j1', data });

  it('throws on a transient failure so the queue retries, and returns otherwise', async () => {
    const { deliveryId } = await seed();
    const processor = createNotificationProcessor(opts(fakeMailer([mkErr({ code: 'ECONNECTION' })])));

    await expect(processor(job({ deliveryId }))).rejects.toThrow('will be retried');
    expect(await processor(job({ deliveryId }))).toEqual({ status: 'sent' });
  });

  it('does NOT throw for a permanent failure (a retry cannot help)', async () => {
    const { deliveryId } = await seed();
    const processor = createNotificationProcessor(opts(fakeMailer([mkErr({ code: 'EENVELOPE' })])));
    await expect(processor(job({ deliveryId }))).resolves.toEqual({ status: 'failed' });
  });

  it.each([[undefined], [{}], [{ deliveryId: 'nope' }]])('rejects an invalid payload as unrecoverable: %j', async (data) => {
    const err = await createNotificationProcessor(opts(fakeMailer()))(job(data)).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
  });
});