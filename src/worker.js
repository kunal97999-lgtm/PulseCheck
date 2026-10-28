import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { closePool } from './db/pool.js';
import { createRedisConnection } from './queues/connection.js';
import { createCheckQueue } from './queues/checkQueue.js';
import { createNotificationQueue } from './queues/notificationQueue.js';
import { createCheckWorker } from './workers/checkWorker.js';
import { createNotificationWorker } from './workers/notificationWorker.js';
import { createCheckProcessor } from './workers/processors.js';
import { createNotificationProcessor } from './workers/notificationProcessor.js';
import { createMailer } from './modules/notifications/mailer.js';
import { startScheduler } from './scheduler/loop.js';
import { startNotificationSweeper } from './scheduler/notificationSweeper.js';
import { startRetentionLoop } from './scheduler/retentionLoop.js';
import { runRetention } from './modules/retention/retention.js';

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { startHeartbeat } from './workers/heartbeat.js';
// Each BullMQ Worker needs its own connection (blocking commands).
const checkWorkerConn = createRedisConnection({ forWorker: true });
const notifyWorkerConn = createRedisConnection({ forWorker: true });
// Producers fail fast: the scheduler holds row locks while it enqueues.
const queueConn = createRedisConnection({ forApi: true });

const queue = createCheckQueue({ connection: queueConn, prefix: env.QUEUE_PREFIX });
const notificationQueue = createNotificationQueue({ connection: queueConn, prefix: env.QUEUE_PREFIX });
const mailer = createMailer();

const worker = createCheckWorker({
  connection: checkWorkerConn,
  prefix: env.QUEUE_PREFIX,
  processor: createCheckProcessor({ notificationQueue }),
  concurrency: env.WORKER_CONCURRENCY,
});

const notificationWorker = createNotificationWorker({
  connection: notifyWorkerConn,
  prefix: env.QUEUE_PREFIX,
  processor: createNotificationProcessor({
    mailer,
    maxAttempts: env.NOTIFICATION_MAX_ATTEMPTS,
    leaseSeconds: env.NOTIFICATION_LEASE_SECONDS,
  }),
  concurrency: 3,
});

const scheduler = startScheduler({
  queue,
  tickMs: env.SCHEDULER_TICK_MS,
  batchSize: env.SCHEDULER_BATCH_SIZE,
});

const sweeper = startNotificationSweeper({
  queue: notificationQueue,
  intervalMs: env.NOTIFICATION_SWEEP_MS,
  staleSeconds: env.NOTIFICATION_STALE_SECONDS,
  maxAttempts: env.NOTIFICATION_MAX_ATTEMPTS,
});

const retention = startRetentionLoop({
  intervalMs: env.RETENTION_INTERVAL_MS,
  run: () =>
    runRetention({
      checkRetentionDays: env.CHECK_RETENTION_DAYS,
      incidentRetentionDays: env.INCIDENT_RETENTION_DAYS,
      batchSize: env.RETENTION_BATCH_SIZE,
      maxBatches: env.RETENTION_MAX_BATCHES,
    }),
});

const heartbeat = startHeartbeat({
  redis: queueConn,
  prefix: env.QUEUE_PREFIX,
  workerId: `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
  intervalMs: env.OPS_HEARTBEAT_MS,
});

logger.info(
  { concurrency: env.WORKER_CONCURRENCY, prefix: env.QUEUE_PREFIX, tickMs: env.SCHEDULER_TICK_MS },
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
    await sweeper.stop();
    await retention.stop();
    await worker.close(); // 2. finish in-flight jobs
    await notificationWorker.close();
    await queue.close();
    await notificationQueue.close();
    await notificationWorker.close();
    await heartbeat.stop(); // still "alive" while jobs were finishing; gone before the connection closes
    await queue.close();
    await checkWorkerConn.quit();
    await notifyWorkerConn.quit();
    
    await queueConn.quit();
    mailer.close();
    await closePool(); // 3. last: everything above uses it
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