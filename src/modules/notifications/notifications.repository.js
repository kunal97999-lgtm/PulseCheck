// Worker/service-side. Not scoped by user.

/**
 * Writes the outbox row for one incident event, honoring the owner's preferences
 * (no preference row means "on"). Idempotent on (incident, event, channel).
 * Returns { id, status } for a NEW row ('pending' or 'skipped'), or null if one exists.
 */
export async function enqueueDelivery({ incidentId, eventType }, db) {
  const { rows } = await db.query(
    `INSERT INTO notification_deliveries (incident_id, event_type, channel, status)
     SELECT i.id, $2::text, 'email',
            CASE WHEN COALESCE(
                   CASE $2::text WHEN 'incident_opened' THEN p.email_on_open
                                 ELSE p.email_on_resolve END,
                   true)
                 THEN 'pending' ELSE 'skipped' END
       FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id
       LEFT JOIN notification_preferences p ON p.user_id = m.user_id
      WHERE i.id = $1::uuid
     ON CONFLICT (incident_id, event_type, channel) DO NOTHING
     RETURNING id, status`,
    [incidentId, eventType],
  );
  return rows[0] ?? null;
}

/**
 * Atomically takes the right to attempt this delivery. Returns null if the row is
 * not pending, is leased by another worker, or has used all its attempts.
 */
export async function claimDelivery(id, { leaseSeconds, maxAttempts }, db) {
  const { rows } = await db.query(
    `UPDATE notification_deliveries SET
        attempt_count   = attempt_count + 1,
        last_attempt_at = now(),
        claimed_until   = now() + ($2::int * interval '1 second')
      WHERE id = $1::uuid
        AND status = 'pending'
        AND attempt_count < $3::int
        AND (claimed_until IS NULL OR claimed_until < now())
      RETURNING id, incident_id, event_type, attempt_count`,
    [id, leaseSeconds, maxAttempts],
  );
  return rows[0] ?? null;
}

/** Recipient is resolved NOW (the owner's current email), not copied into the row. */
export async function loadEmailContext(incidentId, db) {
  const { rows } = await db.query(
    `SELECT u.email AS recipient, m.name AS monitor_name, m.url,
            i.started_at, i.resolved_at, i.failure_type, i.failure_reason
       FROM incidents i
       JOIN monitors m ON m.id = i.monitor_id
       JOIN users u ON u.id = m.user_id
      WHERE i.id = $1::uuid`,
    [incidentId],
  );
  return rows[0] ?? null;
}

export async function markSent(id, db) {
  await db.query(
    `UPDATE notification_deliveries
        SET status = 'sent', sent_at = now(), claimed_until = NULL, sanitized_error_message = NULL
      WHERE id = $1::uuid AND status = 'pending'`,
    [id],
  );
}

/** Transient failure: keep it pending but release the lease so a retry can claim it. */
export async function releaseForRetry(id, message, db) {
  await db.query(
    `UPDATE notification_deliveries
        SET claimed_until = NULL, sanitized_error_message = $2::text
      WHERE id = $1::uuid AND status = 'pending'`,
    [id, message],
  );
}

export async function markFailed(id, message, db) {
  await db.query(
    `UPDATE notification_deliveries
        SET status = 'failed', claimed_until = NULL, sanitized_error_message = $2::text
      WHERE id = $1::uuid AND status = 'pending'`,
    [id, message],
  );
}

/** Old, unleased, unfinished rows for the sweeper. */
export async function findStalePending({ olderThanSeconds, limit }, db) {
  const { rows } = await db.query(
    `SELECT id, attempt_count
       FROM notification_deliveries
      WHERE status = 'pending'
        AND created_at < now() - ($1::int * interval '1 second')
        AND (claimed_until IS NULL OR claimed_until < now())
        AND (last_attempt_at IS NULL OR last_attempt_at < now() - ($1::int * interval '1 second'))
      ORDER BY created_at
      LIMIT $2::int`,
    [olderThanSeconds, limit],
  );
  return rows;
}

/** A worker that died during the LAST attempt leaves a row nobody can claim. Close it out. */
export async function failExhausted(maxAttempts, db) {
  const { rowCount } = await db.query(
    `UPDATE notification_deliveries
        SET status = 'failed', claimed_until = NULL,
            sanitized_error_message = 'Delivery abandoned after repeated attempts'
      WHERE status = 'pending'
        AND attempt_count >= $1::int
        AND (claimed_until IS NULL OR claimed_until < now())`,
    [maxAttempts],
  );
  return rowCount;
}