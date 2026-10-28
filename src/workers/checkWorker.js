import { Worker } from 'bullmq';
import { CHECK_QUEUE } from '../queues/checkQueue.js';
import { logger } from '../utils/logger.js';

export function createCheckWorker({
  connection,
  prefix,
  processor,
  concurrency,
  lockDuration,
  stalledInterval,
  maxStalledCount,
}) {
  const worker = new Worker(CHECK_QUEUE, processor, {
    connection,
    prefix,
    concurrency,
    ...(lockDuration !== undefined && { lockDuration }),
    ...(stalledInterval !== undefined && { stalledInterval }),
    ...(maxStalledCount !== undefined && { maxStalledCount }),
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Worker error');
  });
  worker.on('failed', (job, err) => {
    logger.warn(
      {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        maxAttempts: job?.opts?.attempts,
        err,
      },
      'Job attempt failed',
    );
  });
  worker.on('stalled', (jobId) => {
    logger.warn({ jobId }, 'Job stalled (its worker stopped renewing the lock)');
  });

  return worker;
}