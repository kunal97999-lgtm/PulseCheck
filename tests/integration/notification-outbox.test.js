import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { recordCheckResult } from '../../src/modules/checks/checkResults.service.js';
import { enqueueDelivery } from '../../src/modules/notifications/notifications.repository.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();
const app = createApp();

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const at = (sec) => new Date(T0 + sec * 1000);
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const ok = (sec) => ({ checkedAt: at(sec), success: true, statusCode: 200, latencyMs: 40, errorType: null, errorMessage: null });
const fail = (sec) => ({
  checkedAt: at(sec), success: false, statusCode: null, latencyMs: 100,
  errorType: 'timeout', errorMessage: 'Request timed out',
});
const record = (id, slot, result) => recordCheckResult({ monitorId: id, scheduledFor: at(slot), result });
const failN = async (id, n, start = 0) => {
  for (let i = 0; i < n; i++) await record(id, start + i * 60, fail(start + i * 60 + 1));
};

async function newMonitor() {
  const { token, user } = await registerAndLogin(app);
  const res = await request(app).post('/api/monitors').set(bearer(token))
    .send({ name: 'm', url: 'https://api.example.com/health' }).expect(201);
  return { id: res.body.data.monitor.id, token, userId: user.id };
}
const deliveries = async () =>
  (await pool.query(
    'SELECT * FROM notification_deliveries ORDER BY created_at, event_type',
  )).rows;
const monitorRow = async (id) => (await pool.query('SELECT * FROM monitors WHERE id = $1', [id])).rows[0];

describe('outbox rows are written with the incident', () => {
  it('opening an incident creates exactly one pending incident_opened delivery', async () => {
    const { id } = await newMonitor();
    await failN(id, 2);
    expect(await deliveries()).toHaveLength(0); // below the threshold: nothing

    const out = await record(id, 120, fail(121));
    expect(out.incident.notification).toMatchObject({ status: 'pending' });

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      incident_id: out.incident.id, event_type: 'incident_opened', channel: 'email',
      status: 'pending', attempt_count: 0, last_attempt_at: null, sent_at: null,
    });
  });

  it('continuing failures create no further deliveries', async () => {
    const { id } = await newMonitor();
    await failN(id, 8);
    expect(await deliveries()).toHaveLength(1);
  });

  it('recovery creates one pending incident_resolved delivery', async () => {
    const { id } = await newMonitor();
    await failN(id, 3);
    const out = await record(id, 180, ok(181));
    expect(out.incident).toMatchObject({ action: 'resolved' });

    const rows = await deliveries();
    expect(rows.map((r) => r.event_type).sort()).toEqual(['incident_opened', 'incident_resolved']);
    expect(rows.every((r) => r.incident_id === out.incident.id)).toBe(true);
  });

  it('a second outage is a new incident with its own deliveries', async () => {
    const { id } = await newMonitor();
    await failN(id, 3);
    await record(id, 180, ok(181));
    await failN(id, 3, 240);
    expect(await deliveries()).toHaveLength(3); // opened, resolved, opened
  });

  it('a redelivered threshold-crossing check creates no second delivery', async () => {
    const { id } = await newMonitor();
    await failN(id, 2);
    await record(id, 120, fail(121));
    expect(await record(id, 120, fail(122))).toEqual({ status: 'duplicate' });
    expect(await deliveries()).toHaveLength(1);
  });

  it('a pause-resolved incident sends NO resolved notification (documented decision)', async () => {
    const { id, token } = await newMonitor();
    await failN(id, 3);
    await request(app).post(`/api/monitors/${id}/pause`).set(bearer(token)).expect(200);

    const rows = await deliveries();
    expect(rows.map((r) => r.event_type)).toEqual(['incident_opened']);
  });
});

describe('atomicity: the incident and its outbox row commit together or not at all', () => {
  it('if the outbox insert fails, nothing else is stored', async () => {
    const { id } = await newMonitor();
    await failN(id, 2);

    // A trigger that rejects every outbox insert simulates "the outbox write failed".
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_outbox() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated outbox failure'; END; $$ LANGUAGE plpgsql`);
    await pool.query(`
      CREATE TRIGGER fail_outbox_trg BEFORE INSERT ON notification_deliveries
      FOR EACH ROW EXECUTE FUNCTION fail_outbox()`);
    try {
      await expect(record(id, 120, fail(121))).rejects.toThrow('simulated outbox failure');
    } finally {
      await pool.query('DROP TRIGGER fail_outbox_trg ON notification_deliveries');
      await pool.query('DROP FUNCTION fail_outbox()');
    }

    // Everything the transaction did was rolled back, including the result row.
    expect((await pool.query('SELECT count(*)::int AS n FROM incidents')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM check_results WHERE monitor_id = $1', [id])).rows[0].n).toBe(2);
    expect(await monitorRow(id)).toMatchObject({ current_status: 'pending', consecutive_failures: 2 });

    // The slot is retryable: the same job succeeds once the outbox works again.
    const retry = await record(id, 120, fail(121));
    expect(retry.incident).toMatchObject({ action: 'opened' });
    expect(await deliveries()).toHaveLength(1);
  });
});

describe('preferences', () => {
  it('no preference row means both emails are on', async () => {
    const { id } = await newMonitor();
    await failN(id, 3);
    expect((await deliveries())[0].status).toBe('pending');
  });

  it('opted out of "open" alerts: a skipped row is written, "resolve" still pending', async () => {
    const { id, userId } = await newMonitor();
    await pool.query(
      `INSERT INTO notification_preferences (user_id, email_on_open, email_on_resolve) VALUES ($1, false, true)`,
      [userId],
    );
    await failN(id, 3);
    await record(id, 180, ok(181));

    const byEvent = Object.fromEntries((await deliveries()).map((r) => [r.event_type, r.status]));
    expect(byEvent).toEqual({ incident_opened: 'skipped', incident_resolved: 'pending' });
  });

  it('opted out of everything: both rows are skipped, never pending', async () => {
    const { id, userId } = await newMonitor();
    await pool.query(
      `INSERT INTO notification_preferences (user_id, email_on_open, email_on_resolve) VALUES ($1, false, false)`,
      [userId],
    );
    await failN(id, 3);
    await record(id, 180, ok(181));
    expect((await deliveries()).map((r) => r.status)).toEqual(['skipped', 'skipped']);
  });
});

describe('duplicate-alert prevention', () => {
  it('10 parallel enqueues for the same event create exactly one row', async () => {
    const { id } = await newMonitor();
    await failN(id, 3);
    const { rows: [inc] } = await pool.query('SELECT id FROM incidents');

    const results = await Promise.all(
      Array.from({ length: 10 }, () => enqueueDelivery({ incidentId: inc.id, eventType: 'incident_resolved' }, pool)),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await deliveries()).filter((r) => r.event_type === 'incident_resolved')).toHaveLength(1);
  });

  it('enqueueing for a nonexistent incident writes nothing and does not throw', async () => {
    const r = await enqueueDelivery(
      { incidentId: '00000000-0000-4000-8000-000000000000', eventType: 'incident_opened' }, pool);
    expect(r).toBeNull();
  });
});

describe('database-level guarantees', () => {
  async function anIncident() {
    const { id } = await newMonitor();
    await failN(id, 3);
    return (await pool.query('SELECT id FROM incidents')).rows[0].id;
  }
  const insert = (incidentId, cols) =>
    pool.query(
      `INSERT INTO notification_deliveries (incident_id, event_type, channel, status, sent_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [incidentId, ...cols],
    );

  it('rejects a raw duplicate (incident, event, channel)', async () => {
    const incId = await anIncident(); // already has an incident_opened row
    await expect(insert(incId, ['incident_opened', 'email', 'pending', null])).rejects.toMatchObject({
      code: '23505', constraint: 'notification_deliveries_unique',
    });
  });

  it.each([
    ['unknown event', ['weird', 'email', 'pending', null], 'notification_deliveries_event'],
    ['unknown channel', ['incident_resolved', 'sms', 'pending', null], 'notification_deliveries_channel'],
    ['unknown status', ['incident_resolved', 'email', 'weird', null], 'notification_deliveries_status'],
    ['sent without sent_at', ['incident_resolved', 'email', 'sent', null], 'notification_deliveries_sent_consistent'],
    ['pending with sent_at', ['incident_resolved', 'email', 'pending', new Date()], 'notification_deliveries_sent_consistent'],
  ])('rejects: %s', async (_n, cols, constraint) => {
    const incId = await anIncident();
    await expect(insert(incId, cols)).rejects.toMatchObject({ code: '23514', constraint });
  });

  it('deleting a monitor cascades to incidents and their deliveries', async () => {
    const { id } = await newMonitor();
    await failN(id, 3);
    await pool.query('DELETE FROM monitors WHERE id = $1', [id]);
    expect((await deliveries())).toHaveLength(0);
  });

  it('deleting a user cascades to their preferences', async () => {
    const { userId } = await newMonitor();
    await pool.query(`INSERT INTO notification_preferences (user_id) VALUES ($1)`, [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    expect((await pool.query('SELECT count(*)::int AS n FROM notification_preferences')).rows[0].n).toBe(0);
  });
});