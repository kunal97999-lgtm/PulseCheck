import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Creates a Redis connection. Callers own it and must call quit() on shutdown.
 * Queue and Worker must NOT share one connection: workers use blocking commands.
 */
export function createRedisConnection({ forWorker = false } = {}) {
  const connection = new IORedis(env.REDIS_URL, {
    // BullMQ requires null for workers so they wait through outages instead of throwing.
    ...(forWorker && { maxRetriesPerRequest: null }),
  });

  // Without a listener, a connection error is an unhandled 'error' event.
  connection.on('error', (err) => {
    logger.error({ err: { code: err.code, message: err.message } }, 'Redis connection error');
  });

  return connection;
}