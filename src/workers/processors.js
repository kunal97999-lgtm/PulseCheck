import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { checkAndRecord } from '../modules/checks/checkAndRecord.js';
import { logger } from '../utils/logger.js';

// Job data lives in Redis, so it is validated like any other external input.
const payloadSchema = z.object({
  monitorId: z.string().uuid(),
  scheduledFor: z.string().datetime(), // ISO 8601, e.g. 2026-01-01T00:00:00.000Z
});

/**
 * Builds the processor BullMQ calls for each job.
 * `deps` ({ lookup, policy }) are test seams; production passes nothing.
 *
 * Resolves for every case where the system did its job, including "target is down".
 * Throws only for problems a retry might fix, or UnrecoverableError for ones it can't.
 */
export function createCheckProcessor(deps = {}) {
  return async function processCheckJob(job) {
    const parsed = payloadSchema.safeParse(job.data);
    if (!parsed.success) {
      // Retrying identical bad data cannot help. Fail immediately.
      throw new UnrecoverableError('Invalid check job payload');
    }
    const { monitorId, scheduledFor } = parsed.data;

    // scheduledFor is the slot the scheduler created. It is passed through
    // untouched and never replaced by the clock.
    const outcome = await checkAndRecord({ monitorId, scheduledFor }, deps);

    logger.info(
      {
        jobId: job.id,
        monitorId,
        attempt: job.attemptsMade + 1,
        status: outcome.status,
        success: outcome.result?.success,
        errorType: outcome.result?.errorType,
        latencyMs: outcome.result?.latencyMs,
      },
      'Check job finished',
    );

    // Stored in Redis with the job, so keep it tiny.
    return { status: outcome.status };
  };
}