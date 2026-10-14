import { env } from '../../config/env.js';
import { withTransaction } from '../../db/pool.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
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