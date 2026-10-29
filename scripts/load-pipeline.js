import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pool, closePool } from '../src/db/pool.js';
import { createRedisConnection } from '../src/queues/connection.js';
import { createCheckQueue } from '../src/queues/checkQueue.js';
import { createCheckWorker } from '../src/workers/checkWorker.js';
import { createCheckProcessor } from '../src/workers/processors.js';
import { startScheduler } from '../src/scheduler/loop.js';

const N = Number(process.argv[2] ?? 500); // monitors = checks to complete
const CONCURRENCY = Number(process.argv[3] ?? 5);
const TARGET_DELAY_MS = Number(process.argv[4] ?? 50); // how slow the fake target is
const EMAIL = 'pipeline-bench@example.com';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A loopback target. The production SSRF policy would (correctly) refuse it, so this
// script passes a permissive policy to its OWN in-process processor only.
const server = http.createServer((req, res) => setTimeout(() => res.end('ok'), TARGET_DELAY_MS));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const policy = { isBlockedIp: () => false, allowedPorts: new Set(['', String(port)]) };

const prefix = `bench-${randomUUID()}`;
const conns = [createRedisConnection(), createRedisConnection({ forWorker: true })];
const queue = createCheckQueue({ connection: conns[0], prefix });
let worker;
let scheduler;

async function cleanup() {
  await scheduler?.stop();
  await worker?.close();
  await queue.obliterate({ force: true }).catch(() => {});
  await queue.close();
  await Promise.all(conns.map((c) => c.quit().catch(() => {})));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]); // cascades
  await closePool();
}

try {
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [EMAIL]);
  await pool.query(
    `INSERT INTO monitors (user_id, name, url, timeout_ms, interval_seconds, next_check_at)
     SELECT $1::uuid, 'p' || g, $2::text, 5000, 3600, now() - interval '1 second'
       FROM generate_series(1, $3::int) g`,
    [u.id, `http://127.0.0.1:${port}/`, N],
  );

  worker = createCheckWorker({
    connection: conns[1], prefix, concurrency: CONCURRENCY,
    processor: createCheckProcessor({ policy }),
  });
  await worker.waitUntilReady();

  const started = performance.now();
  scheduler = startScheduler({ queue, tickMs: 100, batchSize: 100 });

  let done = 0;
  while (done < N && performance.now() - started < 180_000) {
    await sleep(100);
    done = (await pool.query('SELECT count(*)::int AS n FROM check_results')).rows[0].n;
  }
  const seconds = (performance.now() - started) / 1000;

  const { rows: [stat] } = await pool.query(
    `SELECT count(*) FILTER (WHERE success)::int AS ok,
            round(avg(latency_ms))::int AS avg_latency_ms
       FROM check_results`);
  console.log(JSON.stringify({
    monitors: N, concurrency: CONCURRENCY, targetDelayMs: TARGET_DELAY_MS,
    completed: done, successful: stat.ok, seconds: Number(seconds.toFixed(2)),
    checksPerSecond: Number((done / seconds).toFixed(1)),
    recordedAvgLatencyMs: stat.avg_latency_ms, // sanity check: should be near the target delay
    timedOut: done < N,
  }, null, 2));
} finally {
  await cleanup();
}