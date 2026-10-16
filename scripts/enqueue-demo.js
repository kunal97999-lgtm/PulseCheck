import { env } from '../src/config/env.js';
import { createRedisConnection } from '../src/queues/connection.js';
import { createCheckQueue } from '../src/queues/checkQueue.js';

const jobId = process.argv[2] ?? `demo_${Date.now()}`;

const connection = createRedisConnection();
const queue = createCheckQueue({ connection, prefix: env.QUEUE_PREFIX });

const job = await queue.add(
  'check',
  { monitorId: 'demo', scheduledFor: new Date().toISOString() },
  { jobId },
);
console.log('enqueued job', job.id);

await queue.close();
await connection.quit();