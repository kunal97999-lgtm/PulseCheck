import { describe, it, expect } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

async function makeMonitor(email = 'inc@example.com') {
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  );
  const { rows: [m] } = await pool.query(
    `INSERT INTO monitors (user_id, name, url) VALUES ($1, 'm', 'https://example.com/') RETURNING id`,
    [u.id],
  );
  return m.id;
}

const T = (n) => new Date(Date.UTC(2026, 0, 1, 0, n));
const open = (id, over = {}) =>
  pool.query(
    `INSERT INTO incidents (monitor_id, status, first_failed_at, started_at, resolved_at, resolution_reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, over.status ?? 'open', over.first ?? T(0), over.started ?? T(2), over.resolved ?? null, over.reason ?? null],
  );

describe('incidents: database guarantees', () => {
  it('allows only ONE open incident per monitor', async () => {
    const id = await makeMonitor();
    await open(id);
    await expect(open(id)).rejects.toMatchObject({
      code: '23505',
      constraint: 'incidents_one_open_per_monitor',
    });
  });

  it('allows a new open incident once the previous one is resolved', async () => {
    const id = await makeMonitor();
    await open(id, { status: 'resolved', resolved: T(10), reason: 'recovered' });
    await open(id); // no error: the unique index only covers open rows
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM incidents');
    expect(rows[0].n).toBe(2);
  });

  it('allows open incidents on different monitors', async () => {
    const a = await makeMonitor('a@example.com');
    const b = await makeMonitor('b@example.com');
    await open(a);
    await open(b);
  });

  it.each([
    ['open but already has resolved_at', { resolved: T(5), reason: 'recovered' }],
    ['resolved without a timestamp', { status: 'resolved', reason: 'recovered' }],
    ['resolved without a reason', { status: 'resolved', resolved: T(5) }],
  ])('rejects an inconsistent row: %s', async (_n, over) => {
    const id = await makeMonitor();
    await expect(open(id, over)).rejects.toMatchObject({
      code: '23514',
      constraint: 'incidents_resolved_consistent',
    });
  });

  it('rejects impossible time ordering', async () => {
    const id = await makeMonitor();
    await expect(open(id, { first: T(5), started: T(2) })).rejects.toMatchObject({
      constraint: 'incidents_time_order',
    });
    await expect(
      open(id, { status: 'resolved', started: T(5), resolved: T(3), reason: 'recovered' }),
    ).rejects.toMatchObject({ constraint: 'incidents_time_order' });
  });

  it('rejects an unknown status, resolution reason, or failure type', async () => {
    const id = await makeMonitor();
    await expect(open(id, { status: 'weird' })).rejects.toMatchObject({ constraint: 'incidents_resolved_consistent' });
    await expect(
      open(id, { status: 'resolved', resolved: T(5), reason: 'bored' }),
    ).rejects.toMatchObject({ constraint: 'incidents_resolution_valid' });
    await expect(
      pool.query(
        `INSERT INTO incidents (monitor_id, first_failed_at, started_at, failure_type)
         VALUES ($1, now(), now(), 'weird')`,
        [id],
      ),
    ).rejects.toMatchObject({ constraint: 'incidents_failure_type_valid' });
  });

  it('deleting a monitor deletes its incidents (ON DELETE CASCADE)', async () => {
    const id = await makeMonitor();
    await open(id);
    await pool.query('DELETE FROM monitors WHERE id = $1', [id]);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM incidents');
    expect(rows[0].n).toBe(0);
  });

  it('rejects an incident for a monitor that does not exist (foreign key)', async () => {
    await expect(open('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: '23503' });
  });
});