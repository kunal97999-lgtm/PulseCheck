import { pool } from '../../db/pool.js';

const COLUMNS = `id, name, description, url, interval_seconds, timeout_ms,
  expected_status_min, expected_status_max, failure_threshold, recovery_threshold,
  is_active, current_status, consecutive_failures, last_checked_at,
  created_at, updated_at`;
// user_id is deliberately not selected: it never leaves the data layer.

export async function lockUser(userId, db) {
  await db.query(`SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE`, [userId]);
}

export async function countByUser(userId, db = pool) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM monitors WHERE user_id = $1`,
    [userId],
  );
  return rows[0].n;
}

export async function insert(userId, m, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO monitors
       (user_id, name, description, url, interval_seconds, timeout_ms,
        expected_status_min, expected_status_max, failure_threshold,
        recovery_threshold, next_check_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     RETURNING ${COLUMNS}`,
    [
      userId, m.name, m.description ?? null, m.url, m.intervalSeconds, m.timeoutMs,
      m.expectedStatusMin, m.expectedStatusMax, m.failureThreshold, m.recoveryThreshold,
    ],
  );
  return rows[0];
}

export async function findByIdForUser(id, userId, db = pool) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM monitors WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function listByUser(userId, { limit, offset }, db = pool) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM monitors
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return rows;
}