import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export const NOTIFICATION_QUEUE = 'notifications';

export function createNotificationQueue({
  connection,
  prefix,
  attempts = env.NOTIFICATION_MAX_ATTEMPTS,
  backoffMs = env.NOTIFICATION_BACKOFF_MS,
}) {
  const queue = new Queue(NOTIFICATION_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: {
      attempts,
      backoff: { type: 'exponential', delay: backoffMs },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });
  queue.on('error', (err) => logger.error({ err }, 'Notification queue error'));
  return queue;
}