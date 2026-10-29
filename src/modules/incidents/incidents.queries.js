import { pool } from '../../db/pool.js';

const SELECT = `
  SELECT i.id, i.monitor_id, m.name AS monitor_name, i.status,
         i.first_failed_at, i.started_at, i.resolved_at, i.resolution_reason,
         i.failure_type, i.failure_reason,
         GREATEST(0, floor(extract(epoch FROM (COALESCE(i.resolved_at, now()) - i.started_at))))::int
           AS duration_seconds
    FROM incidents i
    JOIN monitors m ON m.id = i.monitor_id`;

/** Ownership is part of the query: someone else's incident is simply "not found". */
export async function findByIdForUser(id, userId, db = pool) {
  const { rows } = await db.query(
    `${SELECT} WHERE i.id = $1::uuid AND m.user_id = $2::uuid`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function listForUser(userId, { status, monitorId, limit, offset }, db = pool) {
  const { rows } = await db.query(
    `${SELECT}
      WHERE m.user_id = $1::uuid
        AND ($2::text IS NULL OR i.status = $2::text)
        AND ($3::uuid IS NULL OR i.monitor_id = $3::uuid)
      ORDER BY i.started_at DESC, i.id DESC
      LIMIT $4::int OFFSET $5::int`,
    [userId, status ?? null, monitorId ?? null, limit, offset],
  );
  return rows;
}