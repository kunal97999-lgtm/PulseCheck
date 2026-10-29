import { logger } from '../../utils/logger.js';
import { countLiveWorkers } from '../../workers/heartbeat.js';
import * as queries from './ops.queries.js';
import { evaluateStatus } from './status.js';

const COUNT_STATES = ['waiting', 'active', 'delayed', 'failed'];

// A failing source becomes null (and a status reason), never an exception or an error message.
const attempt = async (name, fn) => {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ source: name, err: { code: err?.code, message: err?.message } }, 'Ops status source failed');
    return null;
  }
};

/**
 * config: { overdueSeconds, notificationLagSeconds, workerStaleSeconds }
 * queues: { checks, notifications } (BullMQ Queues)
 */
export async function collectStatus({ redis, queues, prefix, config, now = new Date() }) {
  const [live, checks, notifications, lag, pending] = await Promise.all([
    attempt('workers', () => countLiveWorkers(redis, prefix, { now: now.getTime(), staleMs: config.workerStaleSeconds * 1000 })),
    attempt('check-queue', () => queues.checks.getJobCounts(...COUNT_STATES)),
    attempt('notification-queue', () => queues.notifications.getJobCounts(...COUNT_STATES)),
    attempt('pipeline-lag', () => queries.pipelineLag(config.overdueSeconds)),
    attempt('pending-notifications', () => queries.pendingNotifications()),
  ]);

  const redisOk = live !== null && checks !== null && notifications !== null;
  const dbOk = lag !== null && pending !== null;

  const { status, reasons } = evaluateStatus(
    {
      redisOk,
      dbOk,
      liveWorkers: live,
      overdueMonitors: lag?.overdueMonitors,
      oldestPendingNotificationSeconds: pending?.oldestPendingSeconds,
    },
    { notificationLagSeconds: config.notificationLagSeconds },
  );

  return {
    status,
    reasons,
    checkedAt: now,
    workers: { live },
    scheduler: lag && { ...lag, thresholdSeconds: config.overdueSeconds },
    queues: { checks, notifications },
    notifications: pending,
  };
}