import { Worker } from 'bullmq';
import { NOTIFICATION_QUEUE } from '../queues/notificationQueue.js';
import { logger } from '../utils/logger.js';

export function createNotificationWorker({ connection, prefix, processor, concurrency }) {
  const worker = new Worker(NOTIFICATION_QUEUE, processor, { connection, prefix, concurrency });
  worker.on('error', (err) => logger.error({ err }, 'Notification worker error'));
  worker.on('failed', (job, err) =>
    logger.warn({ jobId: job?.id, attemptsMade: job?.attemptsMade, err: { message: err?.message } }, 'Notification job attempt failed'),
  );
  return worker;
}