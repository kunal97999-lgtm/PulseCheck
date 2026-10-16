import { withTransaction } from '../db/pool.js';

/**
 * The job id for one monitor + one slot. Deterministic, so enqueuing the same
 * slot twice is a no-op. (BullMQ custom ids must not contain ':'.)
 */
export function slotJobId(monitorId, slot) {
  return `${monitorId}_${slot.getTime()}`;
}

/**
 * One scheduler pass. Atomically: claim due monitors, move their schedule
 * forward, and enqueue one job per claimed monitor.
 * Returns { enqueued }.
 */
export async function runSchedulerTick({ queue, batchSize }) {
  return withTransaction(async (client) => {
    // Claim due monitors. SKIP LOCKED: rows another ticker holds are ignored, not waited on.
    // Uses the partial index monitors_due_idx (active monitors, ordered by due time).
    const { rows: due } = await client.query(
      `SELECT id, next_check_at
         FROM monitors
        WHERE is_active AND next_check_at <= now()
        ORDER BY next_check_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    if (due.length === 0) return { enqueued: 0 };

    // Jump to the first slot strictly after now, on the monitor's own cadence.
    // Overdue by 7 minutes on a 5-minute interval: elapsed 420s, floor(420/300)+1 = 2
    // intervals ahead, so one check now and the next at the right future slot.
    // updated_at is untouched: it means "configuration changed".
    await client.query(
      `UPDATE monitors
          SET next_check_at = next_check_at + make_interval(secs =>
                ((floor(extract(epoch FROM (now() - next_check_at)) / interval_seconds) + 1)
                  * interval_seconds)::double precision)
        WHERE id = ANY($1::uuid[])`,
      [due.map((r) => r.id)],
    );

    // If this throws, the transaction rolls back and the slots are retried next tick.
    await queue.addBulk(
      due.map((r) => ({
        name: 'check',
        data: { monitorId: r.id, scheduledFor: r.next_check_at.toISOString() },
        opts: { jobId: slotJobId(r.id, r.next_check_at) },
      })),
    );

    return { enqueued: due.length };
  });
}