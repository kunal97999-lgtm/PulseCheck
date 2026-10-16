import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { pool } from '../../src/db/pool.js';
import { createCheckProcessor } from '../../src/workers/processors.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

const servers = [];
async function startServer(handler) {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { state, port: server.address().port };
}
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
});

// Test-only: loopback and the test server's random port are allowed.
const permissive = (port) => ({ isBlockedIp: () => false, allowedPorts: new Set(['', String(port)]) });

const SLOT = '2026-01-01T00:00:00.000Z';
const job = (data, attemptsMade = 0) => ({ id: 'job-1', data, attemptsMade });

async function insertMonitor({ url, isActive = true } = {}) {
  const user = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`p-${randomUUID()}@example.com`],
  );
  const { rows } = await pool.query(
    `INSERT INTO monitors (user_id, name, url, timeout_ms, is_active)
     VALUES ($1, 'm', $2, 3000, $3::boolean) RETURNING id`,
    [user.rows[0].id, url ?? 'https://example.com/', isActive],
  );
  return rows[0].id;
}
const resultRows = async (id) =>
  (await pool.query('SELECT * FROM check_results WHERE monitor_id = $1', [id])).rows;

describe('processor: the system did its job', () => {
  it('runs the check and records the result under the payload slot', async () => {
    const { port } = await startServer((req, res) => res.end('ok'));
    const id = await insertMonitor({ url: `http://127.0.0.1:${port}/` });
    const processor = createCheckProcessor({ policy: permissive(port) });

    expect(await processor(job({ monitorId: id, scheduledFor: SLOT }))).toEqual({ status: 'recorded' });

    const [row] = await resultRows(id);
    expect(row).toMatchObject({ success: true, status_code: 200 });
    expect(row.scheduled_for).toEqual(new Date(SLOT));
  });

  it('a DOWN target still completes the job (stored as a failed result, not thrown)', async () => {
    const { port } = await startServer((req, res) => {
      res.statusCode = 503;
      res.end();
    });
    const id = await insertMonitor({ url: `http://127.0.0.1:${port}/` });
    const processor = createCheckProcessor({ policy: permissive(port) });

    await expect(processor(job({ monitorId: id, scheduledFor: SLOT }))).resolves.toEqual({
      status: 'recorded',
    });
    expect((await resultRows(id))[0]).toMatchObject({
      success: false, status_code: 503, error_type: 'http_status',
    });
  });

  it('completes for a deleted monitor and for a paused one', async () => {
    const processor = createCheckProcessor();
    expect(await processor(job({ monitorId: randomUUID(), scheduledFor: SLOT }))).toEqual({
      status: 'monitor_missing',
    });

    const paused = await insertMonitor({ isActive: false });
    expect(await processor(job({ monitorId: paused, scheduledFor: SLOT }))).toEqual({
      status: 'skipped_inactive',
    });
    expect(await resultRows(paused)).toHaveLength(0);
  });

  it('a redelivered job (same slot) completes as a duplicate and stores nothing new', async () => {
    const { state, port } = await startServer((req, res) => res.end('ok'));
    const id = await insertMonitor({ url: `http://127.0.0.1:${port}/` });
    const processor = createCheckProcessor({ policy: permissive(port) });

    await processor(job({ monitorId: id, scheduledFor: SLOT }));
    expect(await processor(job({ monitorId: id, scheduledFor: SLOT }, 1))).toEqual({
      status: 'duplicate',
    });
    expect(state.requests).toBe(2); // executed twice
    expect(await resultRows(id)).toHaveLength(1); // stored once
  });
});

describe('processor: what should NOT be retried', () => {
  it.each([
    ['undefined data', undefined],
    ['empty object', {}],
    ['a string', 'hello'],
    ['non-uuid monitorId (the Day 1 demo payload)', { monitorId: 'demo', scheduledFor: SLOT }],
    ['missing scheduledFor', { monitorId: randomUUID() }],
    ['bad scheduledFor', { monitorId: randomUUID(), scheduledFor: 'not-a-date' }],
  ])('rejects an invalid payload as UnrecoverableError: %s', async (_n, data) => {
    const err = await createCheckProcessor()(job(data)).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
  });
});

describe('processor: what SHOULD be retried', () => {
  it('lets an infrastructure error propagate as a normal (retryable) error', async () => {
    const spy = vi
      .spyOn(pool, 'query')
      .mockRejectedValueOnce(Object.assign(new Error('terminating connection'), { code: '57P01' }));
    try {
      const err = await createCheckProcessor()(
        job({ monitorId: randomUUID(), scheduledFor: SLOT }),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err.code).toBe('57P01');
    } finally {
      spy.mockRestore();
    }
  });
});