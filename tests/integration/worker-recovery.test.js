
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRedisConnection } from '../../src/queues/connection.js';
import { createCheckQueue } from '../../src/queues/checkQueue.js';
import { createCheckWorker } from '../../src/workers/checkWorker.js';

const fixture = fileURLToPath(
  new URL('../fixtures/hanging-worker.js', import.meta.url),
);

let queue;
let recovery;
let child;
let connections = [];

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
  }

  await recovery?.close();
  await queue?.obliterate({ force: true }).catch(() => {});
  await queue?.close();

  await Promise.all(
    connections.map((connection) => connection.quit().catch(() => {})),
  );

  queue = undefined;
  recovery = undefined;
  child = undefined;
  connections = [];
});

describe('killed worker', () => {
  it(
    'a job whose worker was SIGKILLed mid-run is recovered and re-run by another worker',
    async () => {
      const prefix = `test-${randomUUID()}`;

      connections = [
        createRedisConnection(),
        createRedisConnection({ forWorker: true }),
      ];

      queue = createCheckQueue({
        connection: connections[0],
        prefix,
      });

      // 1. A separate OS process takes the job and hangs.
      child = spawn(process.execPath, [fixture], {
        env: {
          ...process.env,
          FIXTURE_PREFIX: prefix,
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      });

      let out = '';
      child.stdout.on('data', (data) => {
        out += data;
      });

      await vi.waitFor(() => {
        expect(out).toContain('READY');
      }, { timeout: 15000 });

      await queue.add('check', { n: 1 }, { jobId: 'victim' });

      await vi.waitFor(() => {
        expect(out).toContain('STARTED victim');
      }, { timeout: 15000 });

      // 2. Kill it without giving it a chance to clean up.
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;

      // 3. Another worker detects the expired lock and processes the job.
      const seen = [];
      const stalled = [];

      recovery = createCheckWorker({
        connection: connections[1],
        prefix,
        processor: async (job) => {
          seen.push(job.data);
        },
        concurrency: 1,
        lockDuration: 1000,
        stalledInterval: 500,
      });

      recovery.on('stalled', (jobId) => {
        stalled.push(jobId);
      });

      // Wait until the job has been recovered and completed.
      await vi.waitFor(
        async () => {
          expect(seen).toEqual([{ n: 1 }]);
          expect(stalled).toContain('victim');
          expect(
            (await queue.getJobCounts('completed')).completed,
          ).toBe(1);
        },
        { timeout: 20000, interval: 100 },
      );
    },
    45000,
  );
});
