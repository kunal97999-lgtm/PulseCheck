import { pool } from '../../db/pool.js';

const COLUMNS = `id, name, description, url, interval_seconds, timeout_ms,
  expected_status_min, expected_status_max, failure_threshold, recovery_threshold,
  is_active, current_status, consecutive_failures, last_checked_at,
  created_at, updated_at`;
// user_id is deliberately not selected: it never leaves the data layer.

/** Serializes concurrent creates for one user. Must be called inside a transaction. */
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

/** Ownership is part of the query: someone else's monitor is simply "not found". */
export async function findByIdForUser(id, userId, db = pool) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM monitors WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

/** Row lock for read-modify-write. Must be called inside a transaction. */
export async function findByIdForUserForUpdate(id, userId, db) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM monitors WHERE id = $1 AND user_id = $2 FOR UPDATE`,
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

export async function update(id, userId, m, resetState, db = pool) {
  const { rows } = await db.query(
    `UPDATE monitors SET
        name = $3::text,
        description = $4::text,
        url = $5::text,
        interval_seconds = $6::int,
        timeout_ms = $7::int,
        expected_status_min = $8::int,
        expected_status_max = $9::int,
        failure_threshold = $10::int,
        recovery_threshold = $11::int,
        current_status        = CASE WHEN $12::boolean THEN 'pending' ELSE current_status END,
        consecutive_failures  = CASE WHEN $12::boolean THEN 0 ELSE consecutive_failures END,
        consecutive_successes = CASE WHEN $12::boolean THEN 0 ELSE consecutive_successes END,
        config_version        = CASE WHEN $12::boolean THEN config_version + 1 ELSE config_version END,
         failure_streak_started_at = CASE WHEN $12::boolean THEN NULL ELSE failure_streak_started_at END,
        next_check_at = CASE
          WHEN NOT is_active   THEN NULL
          WHEN $12::boolean    THEN now()
          ELSE LEAST(next_check_at, now() + ($6::int * interval '1 second'))
        END,
        updated_at = now()
      WHERE id = $1::uuid AND user_id = $2::uuid
      RETURNING ${COLUMNS}`,
    [
      id, userId, m.name, m.description, m.url, m.intervalSeconds, m.timeoutMs,
      m.expectedStatusMin, m.expectedStatusMax, m.failureThreshold, m.recoveryThreshold,
      resetState,
    ],
  );
  return rows[0] ?? null;
}


/** Idempotent. updated_at only moves if something actually changed. */
export async function pause(id, userId, db = pool) {
  const { rows } = await db.query(
    `UPDATE monitors SET
        updated_at = CASE WHEN is_active THEN now() ELSE updated_at END,
        is_active = false,
        next_check_at = NULL
      WHERE id = $1 AND user_id = $2
      RETURNING ${COLUMNS}`,
    [id, userId],
  );
  return rows[0] ?? null;
}

/**
 * Idempotent. Every CASE sees the OLD row, so "was it paused?" is decided
 * atomically inside this one statement. Resuming an active monitor changes nothing.
 * Resuming a paused one resets state AND bumps config_version, so a check that
 * started before the pause can't write into the fresh state.
 */
export async function resume(id, userId, db = pool) {
  const { rows } = await db.query(
    `UPDATE monitors SET
        current_status        = CASE WHEN is_active THEN current_status ELSE 'pending' END,
        consecutive_failures  = CASE WHEN is_active THEN consecutive_failures ELSE 0 END,
        consecutive_successes = CASE WHEN is_active THEN consecutive_successes ELSE 0 END,
        config_version        = CASE WHEN is_active THEN config_version ELSE config_version + 1 END,
        failure_streak_started_at = CASE WHEN is_active THEN failure_streak_started_at ELSE NULL END,
        next_check_at         = CASE WHEN is_active THEN next_check_at ELSE now() END,
        updated_at            = CASE WHEN is_active THEN updated_at ELSE now() END,
        is_active = true
      WHERE id = $1 AND user_id = $2
      RETURNING ${COLUMNS}`,
    [id, userId],
  );
  return rows[0] ?? null;
}


/** Returns true if a row was deleted. Dependent rows cascade (results, incidents later). */
export async function remove(id, userId, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM monitors WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rowCount === 1;
}

