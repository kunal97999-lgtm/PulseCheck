import { pool } from '../../db/pool.js';
import { runCheck } from './runCheck.js';
import { recordCheckResult } from './checkResults.service.js';
import * as repo from './checks.repository.js';

function normalizeSlot(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('scheduledFor must be a valid date');
  }
  return date;
}

/**
 * Loads a monitor, checks it with NO lock or transaction open, then records the result.
 *
 * `scheduledFor` is the idempotency key. It must come from the job payload,
 * never from the clock at execution time.
 *
 * Returns one of:
 *   { status: 'monitor_missing' }
 *   { status: 'skipped_inactive' }
 *   { status: 'duplicate' | 'recorded' | 'monitor_missing' | 'stale_config', ..., result }
 * `deps` ({ lookup, policy }) are test seams; production passes nothing.
 */
export async function checkAndRecord({ monitorId, scheduledFor }, deps = {}) {
  const slot = normalizeSlot(scheduledFor);

  // Phase 1: plain read. The connection returns to the pool immediately.
  const monitor = await repo.findMonitorForCheck(monitorId, pool);
  if (!monitor) return { status: 'monitor_missing' };
  if (!monitor.is_active) return { status: 'skipped_inactive' };

  // Phase 2: network I/O, no transaction, no lock. runCheck never throws.
  const result = await runCheck(
    {
      id: monitor.id,
      url: monitor.url,
      timeoutMs: monitor.timeout_ms,
      expectedStatusMin: monitor.expected_status_min,
      expectedStatusMax: monitor.expected_status_max,
    },
    deps,
  );

  // Phase 3: short transaction. Idempotent on (monitorId, slot), and discarded
  // if the monitor's configuration was reset since Phase 1.
  const outcome = await recordCheckResult({
    monitorId,
    scheduledFor: slot,
    configVersion: monitor.config_version,
    result,
  });
  return { ...outcome, result };
}