import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const CHECK_QUEUE = 'monitor-checks';

/**
 * Retries apply to INFRASTRUCTURE failures only (see processors.js).
 * attempts counts the first try: 3 means one try plus two retries.
 * Finished jobs are trimmed so Redis can't grow without bound.
 */
export function buildJobOptions({ attempts, backoffMs }) {
  return {
    attempts,
    backoff: { type: 'exponential', delay: backoffMs },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
  };
}

export function createCheckQueue({
  connection,
  prefix,
  attempts = env.CHECK_JOB_ATTEMPTS,
  backoffMs = env.CHECK_JOB_BACKOFF_MS,
}) {
  const queue = new Queue(CHECK_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: buildJobOptions({ attempts, backoffMs }),
  });
  queue.on('error', (err) => {
    logger.error({ err }, 'Queue error');
  });
  return queue;
}