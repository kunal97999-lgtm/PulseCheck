/**
 * Pure function: given a monitor's current counters and one check outcome,
 * returns the new counters and status. No database, no clock.
 */
export function nextMonitorState(monitor, success) {
  const consecutiveFailures = success ? 0 : monitor.consecutive_failures + 1;
  const consecutiveSuccesses = success ? monitor.consecutive_successes + 1 : 0;

  let status = monitor.current_status;
  if (success && consecutiveSuccesses >= monitor.recovery_threshold) {
    status = 'up';
  } else if (!success && consecutiveFailures >= monitor.failure_threshold) {
    status = 'down';
  }

  return { status, consecutiveFailures, consecutiveSuccesses };
}
/** When did the current failure streak begin? null once a check succeeds. */
export function nextStreakStart(monitor, success, checkedAt) {
  if (success) return null;
  if (monitor.consecutive_failures === 0 || !monitor.failure_streak_started_at) return checkedAt;
  return monitor.failure_streak_started_at;
}

/** Which incident action does a monitor status transition cause? */
export function incidentAction(previousStatus, nextStatus) {
  if (nextStatus === 'down' && previousStatus !== 'down') return 'open';
  if (previousStatus === 'down' && nextStatus === 'up') return 'resolve';
  return null;
}