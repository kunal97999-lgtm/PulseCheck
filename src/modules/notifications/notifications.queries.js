import { pool } from '../../db/pool.js';

const SELECT = `
  SELECT d.id, d.incident_id, i.monitor_id, m.name AS monitor_name,
         d.event_type, d.channel, d.status, d.attempt_count,
         d.last_attempt_at, d.sent_at, d.sanitized_error_message, d.created_at
    FROM notification_deliveries d
    JOIN incidents i ON i.id = d.incident_id
    JOIN monitors m ON m.id = i.monitor_id`;

export async function listForUser(userId, { status, limit, offset }, db = pool) {
  const { rows } = await db.query(
    `${SELECT}
      WHERE m.user_id = $1::uuid
        AND ($2::text IS NULL OR d.status = $2::text)
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $3::int OFFSET $4::int`,
    [userId, status ?? null, limit, offset],
  );
  return rows;
}

export async function getPreferences(userId, db = pool) {
  const { rows } = await db.query(
    `SELECT email_on_open, email_on_resolve, updated_at
       FROM notification_preferences WHERE user_id = $1::uuid`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * Atomic upsert. A field that is null/omitted keeps its stored value, or
 * defaults to true when the row is being created.
 */
export async function upsertPreferences(userId, { emailOnOpen, emailOnResolve }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO notification_preferences (user_id, email_on_open, email_on_resolve)
     VALUES ($1::uuid, COALESCE($2::boolean, true), COALESCE($3::boolean, true))
     ON CONFLICT (user_id) DO UPDATE SET
        email_on_open    = COALESCE($2::boolean, notification_preferences.email_on_open),
        email_on_resolve = COALESCE($3::boolean, notification_preferences.email_on_resolve),
        updated_at       = now()
     RETURNING email_on_open, email_on_resolve, updated_at`,
    [userId, emailOnOpen ?? null, emailOnResolve ?? null],
  );
  return rows[0];
}