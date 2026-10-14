import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { createApp } from './app.js';
import { closePool } from './db/pool.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API server listening');
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();

  server.close(async (err) => {
    if (err) {
      logger.error({ err }, 'Error closing HTTP server');
      process.exit(1);
    }
    logger.info('HTTP server closed');
    try {
      await closePool();
      logger.info('Database pool closed');
      process.exit(0);
    } catch (poolErr) {
      logger.error({ err: poolErr }, 'Error closing database pool');
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