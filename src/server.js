import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { createApp } from './app.js';
import { closePool } from './db/pool.js';
import { createRedisConnection } from './queues/connection.js';
import { createCheckQueue } from './queues/checkQueue.js';
import { createNotificationQueue } from './queues/notificationQueue.js';
import { collectStatus } from './modules/ops/ops.service.js';

const redis = createRedisConnection({ forApi: true });

// Fail fast: don't start a half-working API (rate limits would silently misbehave).
try {
  await redis.ping();
} catch (err) {
  logger.fatal({ err: { code: err.code, message: err.message } }, 'Redis is unreachable at startup');
  process.exit(1);
}

// The API never processes jobs; these handles only read counts for /ops/status.
const queues = {
  checks: createCheckQueue({ connection: redis, prefix: env.QUEUE_PREFIX }),
  notifications: createNotificationQueue({ connection: redis, prefix: env.QUEUE_PREFIX }),
};

const ops = env.OPS_TOKEN
  ? {
      token: env.OPS_TOKEN,
      collect: () =>
        collectStatus({
          redis,
          queues,
          prefix: env.QUEUE_PREFIX,
          config: {
            overdueSeconds: env.OPS_OVERDUE_SECONDS,
            notificationLagSeconds: env.OPS_NOTIFICATION_LAG_SECONDS,
            workerStaleSeconds: env.OPS_WORKER_STALE_SECONDS,
          },
        }),
    }
  : undefined;
const app = createApp({ redis, ops, trustProxyHops: env.TRUST_PROXY_HOPS });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV, opsEnabled: Boolean(ops) }, 'API server listening');
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();

  // Order matters: stop taking requests first, then close dependencies.
  server.close(async (err) => {
    if (err) {
      logger.error({ err }, 'Error closing HTTP server');
      process.exit(1);
    }
    logger.info('HTTP server closed');
    try {
      await queues.checks.close();
      await queues.notifications.close();
      await redis.quit();
      await closePool();
      logger.info('Redis and database connections closed');
      process.exit(0);
    } catch (closeErr) {
      logger.error({ err: closeErr }, 'Error closing connections');
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});