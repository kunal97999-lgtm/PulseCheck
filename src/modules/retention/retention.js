import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

const DAY_MS = 86_400_000;

/**
 * Runs `deleteBatch(limit)` repeatedly. Only NON-EMPTY batches count against the
 * budget, so many empty monitors can't starve the ones that have work.
 * `complete: false` means the budget ran out and more rows may remain.
 */
async function batched(deleteBatch, { batchSize, maxBatches }) {
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const n = await deleteBatch(batchSize);
    if (n === 0) return { deleted, batches, complete: true };
    batches++;
    deleted += n;
    if (n < batchSize) return { deleted, batches, complete: true };
  }
  return { deleted, batches, complete: false };
}

const cutoffFor = (now, days) => new Date(now.getTime() - days * DAY_MS);

async function deleteCheckBatch(monitorId, cutoff, limit, db) {
  const { rowCount } = await db.query(
    `DELETE FROM check_results
      WHERE id IN (
        SELECT id FROM check_results
         WHERE monitor_id = $1::uuid AND checked_at < $2::timestamptz
         ORDER BY checked_at
         LIMIT $3::int
           FOR UPDATE SKIP LOCKED)`,
    [monitorId, cutoff, limit],
  );
  return rowCount;
}

/** Strictly older than the cutoff: a row exactly at the cutoff is kept. */
export async function purgeCheckResults(
  { retentionDays, now = new Date(), batchSize, maxBatches },
  db = pool,
) {
  const cutoff = cutoffFor(now, retentionDays);
  const { rows: monitors } = await db.query('SELECT id FROM monitors');

  let deleted = 0;
  let budget = maxBatches;
  let complete = true;
  for (const m of monitors) {
    if (budget <= 0) {
      complete = false;
      break;
    }
    const r = await batched((limit) => deleteCheckBatch(m.id, cutoff, limit, db), {
      batchSize,
      maxBatches: budget,
    });
    deleted += r.deleted;
    budget -= r.batches;
    if (!r.complete) complete = false;
  }
  return { deleted, complete };
}

export async function purgeExpiredSessions({ now = new Date(), batchSize, maxBatches }, db = pool) {
  const { deleted, complete } = await batched(
    async (limit) =>
      (
        await db.query(
          `DELETE FROM sessions
            WHERE id IN (
              SELECT id FROM sessions
               WHERE expires_at < $1::timestamptz
               ORDER BY expires_at
               LIMIT $2::int
                 FOR UPDATE SKIP LOCKED)`,
          [now, limit],
        )
      ).rowCount,
    { batchSize, maxBatches },
  );
  return { deleted, complete };
}

/** Only RESOLVED incidents. Their notification deliveries go with them (ON DELETE CASCADE). */
export async function purgeResolvedIncidents(
  { retentionDays, now = new Date(), batchSize, maxBatches },
  db = pool,
) {
  const cutoff = cutoffFor(now, retentionDays);
  const { deleted, complete } = await batched(
    async (limit) =>
      (
        await db.query(
          `DELETE FROM incidents
            WHERE id IN (
              SELECT id FROM incidents
               WHERE status = 'resolved' AND resolved_at < $1::timestamptz
               ORDER BY resolved_at
               LIMIT $2::int
                 FOR UPDATE SKIP LOCKED)`,
          [cutoff, limit],
        )
      ).rowCount,
    { batchSize, maxBatches },
  );
  return { deleted, complete };
}

/**
 * One full retention pass. Each task is isolated: a failure in one is logged and
 * reported, and the others still run.
 * config: { checkRetentionDays, incidentRetentionDays, batchSize, maxBatches }
 */
export async function runRetention(config, { now = new Date(), db = pool } = {}) {
  const { batchSize, maxBatches } = config;
  const tasks = {
    checks: () => purgeCheckResults({ retentionDays: config.checkRetentionDays, now, batchSize, maxBatches }, db),
    sessions: () => purgeExpiredSessions({ now, batchSize, maxBatches }, db),
    incidents: () => purgeResolvedIncidents({ retentionDays: config.incidentRetentionDays, now, batchSize, maxBatches }, db),
  };

  const summary = {};
  for (const [name, task] of Object.entries(tasks)) {
    try {
      summary[name] = await task();
    } catch (err) {
      logger.error({ err, task: name }, 'Retention task failed');
      summary[name] = { error: true };
    }
  }
  return summary;
}