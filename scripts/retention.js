import { env } from '../src/config/env.js';
import { closePool } from '../src/db/pool.js';
import { runRetention } from '../src/modules/retention/retention.js';

const started = Date.now();
const summary = await runRetention({
  checkRetentionDays: env.CHECK_RETENTION_DAYS,
  incidentRetentionDays: env.INCIDENT_RETENTION_DAYS,
  batchSize: env.RETENTION_BATCH_SIZE,
  maxBatches: env.RETENTION_MAX_BATCHES,
});
console.log(JSON.stringify(summary, null, 2));
console.log(`took ${Date.now() - started} ms`);
await closePool();