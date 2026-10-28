// Spawned by tests. Takes one job and hangs until killed.
import { createRedisConnection } from '../../src/queues/connection.js';
import { createCheckWorker } from '../../src/workers/checkWorker.js';

const connection = createRedisConnection({ forWorker: true });

createCheckWorker({
  connection,
  prefix: process.env.FIXTURE_PREFIX,
  processor: async (job) => {
    console.log(`STARTED ${job.id}`);
    await new Promise(() => {}); // never resolves
  },
  concurrency: 1,
  lockDuration: 1000, // short, so the lock expires quickly after a kill
  stalledInterval: 500,
});

console.log('READY');