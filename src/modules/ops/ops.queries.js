import { pool } from '../../db/pool.js';

/**
 * Active monitors whose next check is more than `thresholdSeconds` overdue.
 * Uses the partial index monitors_due_idx (active monitors by due time).
 * A healthy scheduler keeps next_check_at in the future, so this is the
 * end-to-end "are checks actually being scheduled" signal.
 */
export async function pipelineLag(thresholdSeconds, db = pool) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS overdue_monitors,
            max(floor(extract(epoch FROM (now() - next_check_at))))::int AS oldest_overdue_seconds
       FROM monitors
      WHERE is_active
        AND next_check_at < now() - ($1::int * interval '1 second')`,
    [thresholdSeconds],
  );
  return {
    overdueMonitors: rows[0].overdue_monitors,
    oldestOverdueSeconds: rows[0].oldest_overdue_seconds ?? 0,
  };
}

/** Uses the partial index notification_deliveries_pending_idx. */
export async function pendingNotifications(db = pool) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS pending,
            max(floor(extract(epoch FROM (now() - created_at))))::int AS oldest_pending_seconds
       FROM notification_deliveries
      WHERE status = 'pending'`,
  );
  return { pending: rows[0].pending, oldestPendingSeconds: rows[0].oldest_pending_seconds ?? 0 };
}