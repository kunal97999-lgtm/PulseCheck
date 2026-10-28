import { withTransaction } from '../../db/pool.js';
import * as repo from './checks.repository.js';
import * as incidents from '../incidents/incidents.repository.js';
import * as notifications from '../notifications/notifications.repository.js';
import { nextMonitorState, nextStreakStart, incidentAction } from './monitorState.js';

/**
 * Stores one check result, updates the monitor's current state, and opens or
 * resolves an incident, all atomically. Safe to call any number of times with
 * the same (monitorId, scheduledFor).
 *
 * Returns one of:
 *   { status: 'monitor_missing' }      monitor was deleted while the check ran
 *   { status: 'skipped_inactive' }     monitor was paused while the check ran; nothing stored
 *   { status: 'stale_config' }         monitor was reset while the check ran; nothing stored
 *   { status: 'duplicate' }            this slot already has a result; nothing changed
 *   { status: 'recorded', stateApplied: false }
 *                                      stored, but a newer result already exists
 *   { status: 'recorded', stateApplied: true, state, incident }
 *                                      incident is null, or { action: 'opened'|'resolved', id }
 */
export async function recordCheckResult({ monitorId, scheduledFor, configVersion, result }) {
  return withTransaction(async (client) => {
    const monitor = await repo.lockMonitorForResult(monitorId, client);
    if (!monitor) return { status: 'monitor_missing' };

    if (configVersion !== undefined && monitor.config_version !== configVersion) {
      return { status: 'stale_config' };
    }

    // A pause that landed mid-check must not let this result open an incident.
    if (!monitor.is_active) return { status: 'skipped_inactive' };

    const inserted = await repo.insertResult(monitorId, scheduledFor, result, client);
    if (!inserted) return { status: 'duplicate' }; // must NOT touch counters or incidents

    // Out-of-order guard: history is always stored, but current state only moves forward.
    const isStale =
      monitor.last_checked_at !== null &&
      monitor.last_checked_at.getTime() >= result.checkedAt.getTime();
    if (isStale) return { status: 'recorded', stateApplied: false };

    const state = nextMonitorState(monitor, result.success);
    const streakStart = nextStreakStart(monitor, result.success, result.checkedAt);
    await repo.updateMonitorState(monitorId, state, streakStart, result.checkedAt, client);

    let incident = null;
    const action = incidentAction(monitor.current_status, state.status);

        if (action === 'open') {
      const firstFailedAt =
        streakStart && streakStart.getTime() <= result.checkedAt.getTime()
          ? streakStart
          : result.checkedAt;
      const id = await incidents.openIncident(
        {
          monitorId,
          firstFailedAt,
          startedAt: result.checkedAt,
          failureType: result.errorType,
          failureReason: result.errorMessage, // already a fixed, sanitized string
        },
        client,
      );
      if (id) {
        // Outbox: same transaction, so the incident and the intent to notify commit together.
        const notification = await notifications.enqueueDelivery(
          { incidentId: id, eventType: 'incident_opened' },
          client,
        );
        incident = { action: 'opened', id, notification };
      }
    } else if (action === 'resolve') {
      const id = await incidents.resolveOpenIncident(
        monitorId,
        { reason: 'recovered', at: result.checkedAt },
        client,
      );
      if (id) {
        const notification = await notifications.enqueueDelivery(
          { incidentId: id, eventType: 'incident_resolved' },
          client,
        );
        incident = { action: 'resolved', id, notification };
      }
    }

    return { status: 'recorded', stateApplied: true, state, incident };
  });
}