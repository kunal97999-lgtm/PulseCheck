// Worker/service-side writes. Not scoped by user: they run on behalf of the system,
// inside a transaction that already holds the monitor row lock.
// User-facing reads (with ownership checks) arrive on Day 3.

/** Returns the new incident id, or null if the monitor already has an open one. */
export async function openIncident(
  { monitorId, firstFailedAt, startedAt, failureType, failureReason },
  db,
) {
  const { rows } = await db.query(
    `INSERT INTO incidents (monitor_id, first_failed_at, started_at, failure_type, failure_reason)
     VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4::text, $5::text)
     ON CONFLICT (monitor_id) WHERE status = 'open' DO NOTHING
     RETURNING id`,
    [monitorId, firstFailedAt, startedAt, failureType, failureReason],
  );
  return rows[0]?.id ?? null;
}

/**
 * Resolves the monitor's open incident, if any. Returns its id, or null if none was open.
 * resolved_at is clamped to started_at so clock skew between the worker and the
 * database can never violate incidents_time_order.
 */
export async function resolveOpenIncident(monitorId, { reason, at = null }, db) {
  const { rows } = await db.query(
    `UPDATE incidents SET
        status = 'resolved',
        resolved_at = GREATEST(COALESCE($3::timestamptz, now()), started_at),
        resolution_reason = $2::text,
        last_updated_at = now()
      WHERE monitor_id = $1::uuid AND status = 'open'
      RETURNING id`,
    [monitorId, reason, at],
  );
  return rows[0]?.id ?? null;
}