import { withTransaction } from '../../db/pool.js';
import * as repo from './checks.repository.js';
import { nextMonitorState } from './monitorState.js';

/**
 * Stores one check result and updates the monitor's current state, atomically.
 * Safe to call any number of times with the same (monitorId, scheduledFor).
 *
 * Returns one of:
 *   { status: 'monitor_missing' }                    monitor was deleted while the check ran
 *   { status: 'duplicate' }                          this slot already has a result; nothing changed
 *   { status: 'recorded', stateApplied: boolean }    stateApplied=false means a newer result already exists
 */
export async function recordCheckResult({ monitorId, scheduledFor, result }) {
  return withTransaction(async (client) => {
    const monitor = await repo.lockMonitorForResult(monitorId, client);
    if (!monitor) return { status: 'monitor_missing' };

    const inserted = await repo.insertResult(monitorId, scheduledFor, result, client);
    if (!inserted) return { status: 'duplicate' }; // must NOT touch counters

    // Out-of-order guard: history is always stored, but current state only moves forward.
    const isStale =
      monitor.last_checked_at !== null &&
      monitor.last_checked_at.getTime() >= result.checkedAt.getTime();
    if (isStale) return { status: 'recorded', stateApplied: false };

    const state = nextMonitorState(monitor, result.success);
    await repo.updateMonitorState(monitorId, state, result.checkedAt, client);
    return { status: 'recorded', stateApplied: true, state };
  });
}