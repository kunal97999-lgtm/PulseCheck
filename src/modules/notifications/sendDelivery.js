import { pool } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import * as repo from './notifications.repository.js';
import { buildEmail } from './emailTemplates.js';
import { classifyMailError } from './classifyMailError.js';

/**
 * One delivery attempt. No lock is held while SMTP runs: the lease (claimed_until)
 * is what keeps two workers from sending the same email at the same moment.
 *
 * Returns { status }: 'sent' | 'failed' | 'retry' | 'not_claimed'.
 * 'retry' tells the caller to throw so the queue schedules another attempt.
 */
export async function sendDelivery(deliveryId, { mailer, maxAttempts, leaseSeconds }) {
  const claimed = await repo.claimDelivery(deliveryId, { leaseSeconds, maxAttempts }, pool);
  if (!claimed) return { status: 'not_claimed' };

  const ctx = await repo.loadEmailContext(claimed.incident_id, pool);
  if (!ctx) {
    await repo.markFailed(deliveryId, 'Incident no longer exists', pool);
    return { status: 'failed' };
  }

  const email = buildEmail({
    eventType: claimed.event_type,
    monitorName: ctx.monitor_name,
    url: ctx.url,
    startedAt: ctx.started_at,
    resolvedAt: ctx.resolved_at,
    failureType: ctx.failure_type,
    failureReason: ctx.failure_reason,
  });

  try {
    await mailer.send({ to: ctx.recipient, subject: email.subject, text: email.text });
  } catch (err) {
    const c = classifyMailError(err);
    // The recipient address is deliberately NOT logged.
    logger.warn(
      { deliveryId, attempt: claimed.attempt_count, permanent: c.permanent, code: err?.code, responseCode: err?.responseCode },
      'Email delivery attempt failed',
    );

    if (c.permanent) {
      await repo.markFailed(deliveryId, c.message, pool);
      return { status: 'failed' };
    }
    if (claimed.attempt_count >= maxAttempts) {
      await repo.markFailed(deliveryId, `${c.message} (gave up after ${claimed.attempt_count} attempts)`, pool);
      return { status: 'failed' };
    }
    await repo.releaseForRetry(deliveryId, c.message, pool);
    return { status: 'retry' };
  }

  await repo.markSent(deliveryId, pool);
  logger.info({ deliveryId, eventType: claimed.event_type, attempt: claimed.attempt_count }, 'Notification sent');
  return { status: 'sent' };
}