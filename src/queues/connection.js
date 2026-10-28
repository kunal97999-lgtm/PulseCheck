import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Creates a Redis connection. Callers own it and must call quit() on shutdown.
 * Queue and Worker must NOT share one connection: workers use blocking commands.
 *
 *   forWorker: BullMQ requires maxRetriesPerRequest: null so workers wait out outages.
 *   forApi:    the opposite. Request handlers must fail fast, never hang on a dead Redis.
 */
export function createRedisConnection({ forWorker = false, forApi = false } = {}) {
  const connection = new IORedis(env.REDIS_URL, {
    ...(forWorker && { maxRetriesPerRequest: null }),
    ...(forApi && { maxRetriesPerRequest: 1, commandTimeout: 2000 }),
  });

  // Without a listener, a connection error is an unhandled 'error' event.
  connection.on('error', (err) => {
    logger.error({ err: { code: err.code, message: err.message } }, 'Redis connection error');
  });

  return connection;
}