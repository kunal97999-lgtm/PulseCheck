import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import * as repo from '../modules/notifications/notifications.repository.js';

/**
 * One sweep: close out abandoned rows, then re-enqueue stale pending ones.
 * The job id includes a time bucket so an old failed/finished job in Redis can't
 * block a revival; the database lease is what prevents double sends.
 */
export async function runNotificationSweep({ queue, staleSeconds, maxAttempts, batchSize = 100 }) {
  const abandoned = await repo.failExhausted(maxAttempts, pool);
  const stale = await repo.findStalePending({ olderThanSeconds: staleSeconds, limit: batchSize }, pool);
  if (stale.length === 0) return { enqueued: 0, abandoned };

  const bucket = Math.floor(Date.now() / (staleSeconds * 1000));
  await queue.addBulk(
    stale.map((r) => ({
      name: 'send',
      data: { deliveryId: r.id },
      opts: { jobId: `sweep_${r.id}_${r.attempt_count}_${bucket}` },
    })),
  );
  return { enqueued: stale.length, abandoned };
}

export function startNotificationSweeper({ queue, intervalMs, staleSeconds, maxAttempts }) {
  let stopped = false;
  let timer = null;
  let running = null;

  async function loop() {
    try {
      const { enqueued, abandoned } = await runNotificationSweep({ queue, staleSeconds, maxAttempts });
      if (enqueued || abandoned) logger.info({ enqueued, abandoned }, 'Notification sweep');
    } catch (err) {
      logger.error({ err }, 'Notification sweep failed');
    }
    if (!stopped) timer = setTimeout(() => { running = loop(); }, intervalMs);
  }

  running = loop();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}