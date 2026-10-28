import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { checkAndRecord } from '../modules/checks/checkAndRecord.js';
import { logger } from '../utils/logger.js';

// Job data lives in Redis, so it is validated like any other external input.
const payloadSchema = z.object({
  monitorId: z.string().uuid(),
  scheduledFor: z.string().datetime(),
});

/**
 * `deps`: { lookup?, policy?, notificationQueue? }. Production passes only notificationQueue.
 * Resolves for every case where the system did its job, including "target is down".
 */
export function createCheckProcessor(deps = {}) {
  const { notificationQueue, ...checkDeps } = deps;

  return async function processCheckJob(job) {
    const parsed = payloadSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('Invalid check job payload');
    const { monitorId, scheduledFor } = parsed.data;

    const outcome = await checkAndRecord({ monitorId, scheduledFor }, checkDeps);

    // Fast path, AFTER the commit. Best effort: the sweeper guarantees delivery,
    // so a Redis problem here must never fail (and retry) a check that already succeeded.
    const notification = outcome.incident?.notification;
    if (notificationQueue && notification?.status === 'pending') {
      try {
        await notificationQueue.add('send', { deliveryId: notification.id }, { jobId: notification.id });
      } catch (err) {
        logger.error({ err, deliveryId: notification.id }, 'Could not enqueue notification; the sweeper will pick it up');
      }
    }

    logger.info(
      {
        jobId: job.id, monitorId, attempt: job.attemptsMade + 1, status: outcome.status,
        success: outcome.result?.success, errorType: outcome.result?.errorType,
        latencyMs: outcome.result?.latencyMs,
      },
      'Check job finished',
    );
    return { status: outcome.status };
  };
} 