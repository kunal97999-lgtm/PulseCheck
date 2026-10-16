import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { closePool } from './db/pool.js';
import { createRedisConnection } from './queues/connection.js';
import { createCheckQueue } from './queues/checkQueue.js';
import { createCheckWorker } from './workers/checkWorker.js';
import { startScheduler } from './scheduler/loop.js';
import { createCheckProcessor } from './workers/processors.js';
// Separate connections: the worker's blocking commands must not share one with the queue.
const workerConnection = createRedisConnection({ forWorker: true });
const queueConnection = createRedisConnection();

const queue = createCheckQueue({ connection: queueConnection, prefix: env.QUEUE_PREFIX });

const worker = createCheckWorker({
  connection: workerConnection,
  prefix: env.QUEUE_PREFIX,
  processor: createCheckProcessor(),
  concurrency: env.WORKER_CONCURRENCY,
});

const scheduler = startScheduler({
  queue,
  tickMs: env.SCHEDULER_TICK_MS,
  batchSize: env.SCHEDULER_BATCH_SIZE,
});

logger.info(
  {
    concurrency: env.WORKER_CONCURRENCY,
    prefix: env.QUEUE_PREFIX,
    tickMs: env.SCHEDULER_TICK_MS,
    batchSize: env.SCHEDULER_BATCH_SIZE,
  },
  'Worker started',
);

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker shutting down');

  setTimeout(() => {
    logger.error('Forced worker exit after shutdown timeout');
    process.exit(1);
  }, env.WORKER_SHUTDOWN_TIMEOUT_MS).unref();

  try {
    await scheduler.stop(); // 1. stop creating new work
    await worker.close(); // 2. finish in-flight jobs, take no new ones
    await queue.close();
    await workerConnection.quit();
    await queueConnection.quit();
    await closePool(); // 3. last, because the scheduler and processors use it
    logger.info('Worker stopped cleanly');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection in worker');
  process.exit(1);
});