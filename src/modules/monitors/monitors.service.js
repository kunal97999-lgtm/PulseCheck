import { env } from '../../config/env.js';
import { withTransaction } from '../../db/pool.js';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors.js';
import * as repo from './monitors.repository.js';

export async function createMonitor(userId, input) {
  return withTransaction(async (client) => {
    await repo.lockUser(userId, client); // concurrent creates by this user queue up here
    const count = await repo.countByUser(userId, client);
    if (count >= env.MAX_MONITORS_PER_USER) {
      throw new AppError(
        403,
        'MONITOR_LIMIT_REACHED',
        `You can have at most ${env.MAX_MONITORS_PER_USER} monitors`,
      );
    }
    return repo.insert(userId, input, client);
  });
}

export async function getMonitor(userId, monitorId) {
  const monitor = await repo.findByIdForUser(monitorId, userId);
  if (!monitor) throw new NotFoundError('Monitor not found');
  return monitor;
}

export function listMonitors(userId, paging) {
  return repo.listByUser(userId, paging);
}

export async function updateMonitor(userId, monitorId, patch) {
  return withTransaction(async (client) => {
    // Lock the row so a concurrent PATCH can't overwrite our merge (lost update).
    const current = await repo.findByIdForUserForUpdate(monitorId, userId, client);
    if (!current) throw new NotFoundError('Monitor not found');

    const next = {
      name: patch.name ?? current.name,
      // null is a valid value here ("clear it"), so test for undefined, not nullish
      description: patch.description === undefined ? current.description : patch.description,
      url: patch.url ?? current.url,
      intervalSeconds: patch.intervalSeconds ?? current.interval_seconds,
      timeoutMs: patch.timeoutMs ?? current.timeout_ms,
      expectedStatusMin: patch.expectedStatusMin ?? current.expected_status_min,
      expectedStatusMax: patch.expectedStatusMax ?? current.expected_status_max,
      failureThreshold: patch.failureThreshold ?? current.failure_threshold,
      recoveryThreshold: patch.recoveryThreshold ?? current.recovery_threshold,
    };

    // Cross-field rule must be checked on the MERGED values.
    if (next.expectedStatusMin > next.expectedStatusMax) {
      throw new ValidationError([
        {
          field: 'expectedStatusMin',
          message: 'expectedStatusMin must be less than or equal to expectedStatusMax',
        },
      ]);
    }

    // Both URLs are already normalized by the schema, so string equality is meaningful.
    const resetState = next.url !== current.url;

    return repo.update(monitorId, userId, next, resetState, client);
  });
}

export async function pauseMonitor(userId, monitorId) {
  const monitor = await repo.pause(monitorId, userId);
  if (!monitor) throw new NotFoundError('Monitor not found');
  return monitor;
}

export async function resumeMonitor(userId, monitorId) {
  const monitor = await repo.resume(monitorId, userId);
  if (!monitor) throw new NotFoundError('Monitor not found');
  return monitor;
}

export async function deleteMonitor(userId, monitorId) {
  const deleted = await repo.remove(monitorId, userId);
  if (!deleted) throw new NotFoundError('Monitor not found');
}