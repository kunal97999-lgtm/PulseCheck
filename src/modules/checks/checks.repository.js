// NOTE: unlike the monitors repository, these functions are NOT scoped by user.
// They are for the worker only, which acts on behalf of the system, never a request.
// Nothing in src/modules/*/routes may import this file.

/** Row lock: serializes result handling per monitor and blocks concurrent DELETE. */
export async function lockMonitorForResult(monitorId, db) {
  const { rows } = await db.query(
    `SELECT id, is_active, current_status, consecutive_failures, consecutive_successes,
            failure_threshold, recovery_threshold, last_checked_at, config_version,
            failure_streak_started_at
       FROM monitors
      WHERE id = $1
        FOR UPDATE`,
    [monitorId],
  );
  return rows[0] ?? null;
}

/** Returns the new row id, or null if this (monitor, slot) already has a result. */
export async function insertResult(monitorId, scheduledFor, r, db) {
  const { rows } = await db.query(
    `INSERT INTO check_results
       (monitor_id, scheduled_for, checked_at, success, status_code,
        latency_ms, error_type, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (monitor_id, scheduled_for) DO NOTHING
     RETURNING id`,
    [
      monitorId, scheduledFor, r.checkedAt, r.success, r.statusCode,
      r.latencyMs, r.errorType, r.errorMessage,
    ],
  );
  return rows[0]?.id ?? null;
}
/** Deliberately does not touch updated_at: that column means "configuration changed". */
export async function updateMonitorState(monitorId, state, streakStartedAt, checkedAt, db) {
  await db.query(
    `UPDATE monitors SET
        current_status           = $2::text,
        consecutive_failures     = $3::int,
        consecutive_successes    = $4::int,
        failure_streak_started_at = $5::timestamptz,
        last_checked_at          = $6::timestamptz
      WHERE id = $1::uuid`,
    [
      monitorId, state.status, state.consecutiveFailures, state.consecutiveSuccesses,
      streakStartedAt, checkedAt,
    ],
  );
}

  
/** Plain read, no lock. Returns only what a check needs. */
export async function findMonitorForCheck(monitorId, db) {
  const { rows } = await db.query(
    `SELECT id, url, timeout_ms, expected_status_min, expected_status_max,
            is_active, config_version
       FROM monitors
      WHERE id = $1`,
    [monitorId],
  );
  return rows[0] ?? null;
}