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