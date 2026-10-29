/**
 * Pure: turns raw signals into a status and machine-readable reasons.
 * A signal is null/undefined when its source was unreachable.
 */
export function evaluateStatus(signals, { notificationLagSeconds }) {
  const down = [];
  const degraded = [];

  if (!signals.redisOk) down.push('redis_unavailable');
  if (!signals.dbOk) down.push('database_unavailable');
  if (signals.redisOk && signals.liveWorkers === 0) down.push('no_live_workers');

  if (signals.dbOk && signals.overdueMonitors > 0 && !down.includes('no_live_workers')) {
    degraded.push('scheduler_lagging');
  }
  if (signals.dbOk && signals.oldestPendingNotificationSeconds > notificationLagSeconds) {
    degraded.push('notifications_lagging');
  }

  // With no workers, overdue monitors are a consequence, not a separate finding,
  // but we still report them in the numbers.
  const reasons = [...down, ...degraded];
  const status = down.length ? 'down' : degraded.length ? 'degraded' : 'ok';
  return { status, reasons };
}