import { describe, it, expect } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { runNotificationSweep } from '../../src/scheduler/notificationSweeper.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

const fakeQueue = () => {
  const added = [];
  return { added, addBulk: async (jobs) => added.push(...jobs) };
};
const sweep = (queue) => runNotificationSweep({ queue, staleSeconds: 120, maxAttempts: 5 });

let n = 0;
async function seedDelivery({ status = 'pending', ageSec = 0, claimedSec = null, attempts = 0, lastAttemptAgoSec = null }) {
  n++;
  const { rows: [u] } = await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`s${n}@example.com`]);
  const { rows: [m] } = await pool.query(`INSERT INTO monitors (user_id, name, url) VALUES ($1, 'm', 'https://example.com/') RETURNING id`, [u.id]);
  const { rows: [i] } = await pool.query(
    `INSERT INTO incidents (monitor_id, first_failed_at, started_at) VALUES ($1, now(), now()) RETURNING id`, [m.id]);
  const { rows: [d] } = await pool.query(
    `INSERT INTO notification_deliveries
       (incident_id, event_type, status, attempt_count, created_at, claimed_until, last_attempt_at, sent_at)
     VALUES ($1, 'incident_opened', $2::text, $3::int,
             now() - ($4::int * interval '1 second'),
             CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int * interval '1 second') END,
             CASE WHEN $6::int IS NULL THEN NULL ELSE now() - ($6::int * interval '1 second') END,
             CASE WHEN $2::text = 'sent' THEN now() END)
     RETURNING id`,
    [i.id, status, attempts, ageSec, claimedSec, lastAttemptAgoSec]);
  return d.id;
}

describe('notification sweeper', () => {
  it('re-enqueues old pending rows (a lost fast-path enqueue)', async () => {
    const id = await seedDelivery({ ageSec: 600 });
    const q = fakeQueue();
    expect(await sweep(q)).toEqual({ enqueued: 1, abandoned: 0 });
    expect(q.added[0].data).toEqual({ deliveryId: id });
    expect(q.added[0].opts.jobId).toContain(id);
  });

  it('ignores fresh rows, finished rows, actively leased rows, and recent retries', async () => {
    await seedDelivery({ ageSec: 5 }); // too new: the fast path is probably still running
    await seedDelivery({ ageSec: 600, status: 'sent' });
    await seedDelivery({ ageSec: 600, status: 'skipped' });
    await seedDelivery({ ageSec: 600, claimedSec: 30, attempts: 1 }); // a worker is sending it now
    await seedDelivery({ ageSec: 600, attempts: 1, lastAttemptAgoSec: 10 }); // mid-backoff
    const q = fakeQueue();
    expect(await sweep(q)).toEqual({ enqueued: 0, abandoned: 0 });
    expect(q.added).toHaveLength(0);
  });

  it('revives a row whose lease expired (a worker died mid-send)', async () => {
    await seedDelivery({ ageSec: 600, claimedSec: -30, attempts: 2, lastAttemptAgoSec: 300 });
    const q = fakeQueue();
    expect((await sweep(q)).enqueued).toBe(1);
  });

  it('closes out a row stuck after its LAST attempt instead of re-enqueueing it forever', async () => {
    const id = await seedDelivery({ ageSec: 600, attempts: 5, lastAttemptAgoSec: 300 });
    const q = fakeQueue();
    expect(await sweep(q)).toEqual({ enqueued: 0, abandoned: 1 });
    const { rows } = await pool.query('SELECT status, sanitized_error_message FROM notification_deliveries WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({ status: 'failed', sanitized_error_message: 'Delivery abandoned after repeated attempts' });
  });
});