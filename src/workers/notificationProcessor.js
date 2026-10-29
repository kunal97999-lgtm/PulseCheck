import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { sendDelivery } from '../modules/notifications/sendDelivery.js';

const payloadSchema = z.object({ deliveryId: z.string().uuid() });

export function createNotificationProcessor({ mailer, maxAttempts, leaseSeconds }) {
  return async function processNotificationJob(job) {
    const parsed = payloadSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('Invalid notification job payload');

    const outcome = await sendDelivery(parsed.data.deliveryId, { mailer, maxAttempts, leaseSeconds });

    // Only a transient failure throws, so the queue's backoff schedules the next attempt.
    if (outcome.status === 'retry') throw new Error('Email delivery will be retried');
    return { status: outcome.status };
  };
}