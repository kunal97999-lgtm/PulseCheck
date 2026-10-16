import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { checkAndRecord } from '../../src/modules/checks/checkAndRecord.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();
const app = createApp();

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

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const slot = (n) => new Date(T0 + n * 60_000);

async function newMonitor(url) {
  const { token } = await registerAndLogin(app);
  const res = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'm', url: 'https://api.example.com/health', timeoutMs: 3000 })
    .expect(201);
  const id = res.body.data.monitor.id;
  if (url) await pool.query('UPDATE monitors SET url = $2 WHERE id = $1', [id, url]);
  return { id, token };
}
const monitorRow = async (id) => (await pool.query('SELECT * FROM monitors WHERE id = $1', [id])).rows[0];
const resultRows = async (id) =>
  (await pool.query('SELECT * FROM check_results WHERE monitor_id = $1 ORDER BY scheduled_for', [id])).rows;
const localUrl = (port) => `http://127.0.0.1:${port}/health`;

describe('checkAndRecord: the full path', () => {
  it('checks a healthy target and records success', async () => {
    const { state, port } = await startServer((req, res) => res.end('ok'));
    const { id } = await newMonitor(localUrl(port));

    const out = await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, { policy: permissive(port) });

    expect(out).toMatchObject({ status: 'recorded', stateApplied: true });
    expect(state.requests).toBe(1);
    const [row] = await resultRows(id);
    expect(row).toMatchObject({ success: true, status_code: 200, error_type: null });
    expect(row.scheduled_for).toEqual(slot(0));
    expect(await monitorRow(id)).toMatchObject({ current_status: 'up', consecutive_failures: 0 });
  });

  it('three failing checks take a monitor down (failure_threshold 3)', async () => {
    const { port } = await startServer((req, res) => {
      res.statusCode = 503;
      res.end();
    });
    const { id } = await newMonitor(localUrl(port));
    const deps = { policy: permissive(port) };

    for (let i = 0; i < 2; i++) await checkAndRecord({ monitorId: id, scheduledFor: slot(i) }, deps);
    expect(await monitorRow(id)).toMatchObject({ current_status: 'pending', consecutive_failures: 2 });

    await checkAndRecord({ monitorId: id, scheduledFor: slot(2) }, deps);
    expect(await monitorRow(id)).toMatchObject({ current_status: 'down', consecutive_failures: 3 });
    const rows = await resultRows(id);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ status_code: 503, error_type: 'http_status' });
  });

  it("uses the monitor's own success range from the database", async () => {
    const { port } = await startServer((req, res) => {
      res.statusCode = 302;
      res.end();
    });
    const { id } = await newMonitor(localUrl(port));
    const deps = { policy: permissive(port) };

    await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, deps);
    expect((await resultRows(id))[0]).toMatchObject({ success: false, error_type: 'http_status' });

    await pool.query('UPDATE monitors SET expected_status_max = 399 WHERE id = $1', [id]);
    await checkAndRecord({ monitorId: id, scheduledFor: slot(1) }, deps);
    expect((await resultRows(id))[1]).toMatchObject({ success: true, status_code: 302 });
  });

  it('records a refused connection as a failure with a fixed message', async () => {
    const { port } = await startServer((req, res) => res.end());
    const { id } = await newMonitor(localUrl(port));
    await new Promise((resolve) => servers.pop().close(resolve)); // free the port

    await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, { policy: permissive(port) });
    expect((await resultRows(id))[0]).toMatchObject({
      success: false, status_code: null, error_type: 'connection', error_message: 'Connection refused',
    });
  });

  it('records a blocked target with the DEFAULT policy and sends nothing', async () => {
    const { id } = await newMonitor('http://169.254.169.254/latest/meta-data/');
    await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }); // no deps: strict policy

    const [row] = await resultRows(id);
    expect(row).toMatchObject({
      success: false, status_code: null, latency_ms: null, error_type: 'blocked',
      error_message: 'Target is not permitted by security policy',
    });
    expect(JSON.stringify(row)).not.toMatch(/169\.254/);
  });
});

describe('checkAndRecord: skipping and edge cases', () => {
  it('skips a paused monitor: no request, no row, no state change', async () => {
    const { state, port } = await startServer((req, res) => res.end('ok'));
    const { id, token } = await newMonitor(localUrl(port));
    await request(app).post(`/api/monitors/${id}/pause`).set('Authorization', `Bearer ${token}`).expect(200);

    const out = await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, { policy: permissive(port) });

    expect(out).toEqual({ status: 'skipped_inactive' });
    expect(state.requests).toBe(0);
    expect(await resultRows(id)).toHaveLength(0);
    expect((await monitorRow(id)).last_checked_at).toBeNull();
  });

  it('returns monitor_missing for an unknown monitor, with no request sent', async () => {
    const out = await checkAndRecord({
      monitorId: '00000000-0000-4000-8000-000000000000',
      scheduledFor: slot(0),
    });
    expect(out).toEqual({ status: 'monitor_missing' });
  });

  it('returns monitor_missing when the monitor is deleted DURING the check', async () => {
    const { port } = await startServer(() => {});
    const { id } = await newMonitor(null);
    // Replace the handler's behavior: delete the monitor, then answer.
    servers[0].removeAllListeners('request');
    servers[0].on('request', async (req, res) => {
      await pool.query('DELETE FROM monitors WHERE id = $1', [id]);
      res.end('ok');
    });
    await pool.query('UPDATE monitors SET url = $2 WHERE id = $1', [id, localUrl(port)]);

    const out = await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, { policy: permissive(port) });
    expect(out).toMatchObject({ status: 'monitor_missing' });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM check_results');
    expect(rows[0].n).toBe(0);
  });

  it('accepts scheduledFor as an ISO string (the shape a queue payload has)', async () => {
    const { port } = await startServer((req, res) => res.end('ok'));
    const { id } = await newMonitor(localUrl(port));
    const out = await checkAndRecord(
      { monitorId: id, scheduledFor: slot(0).toISOString() },
      { policy: permissive(port) },
    );
    expect(out.status).toBe('recorded');
    expect((await resultRows(id))[0].scheduled_for).toEqual(slot(0));
  });

  it('rejects an invalid scheduledFor loudly instead of guessing a key', async () => {
    const { id } = await newMonitor(null);
    await expect(checkAndRecord({ monitorId: id, scheduledFor: 'not-a-date' })).rejects.toBeInstanceOf(TypeError);
    await expect(checkAndRecord({ monitorId: id, scheduledFor: undefined })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('checkAndRecord: duplicates and locking', () => {
  it('a duplicate delivery runs the check twice but stores it once', async () => {
    const { state, port } = await startServer((req, res) => {
      res.statusCode = 500;
      res.end();
    });
    const { id } = await newMonitor(localUrl(port));
    const deps = { policy: permissive(port) };

    const first = await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, deps);
    const second = await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, deps);

    expect(first.status).toBe('recorded');
    expect(second.status).toBe('duplicate');
    expect(state.requests).toBe(2); // execution happened twice
    expect(await resultRows(id)).toHaveLength(1); // persistence happened once
    expect((await monitorRow(id)).consecutive_failures).toBe(1); // counters not doubled
  });

  it('holds no row lock while the HTTP request is in flight', async () => {
    let writeDuringCheck = null;
    const { id } = await newMonitor(null);
    const { port } = await startServer(async (req, res) => {
      // If checkAndRecord held a lock on the monitor row, this UPDATE would wait
      // for the check to finish, which is waiting for us: a deadlock until timeout.
      const started = Date.now();
      await pool.query(`UPDATE monitors SET description = 'edited-during-check' WHERE id = $1`, [id]);
      writeDuringCheck = Date.now() - started;
      res.end('ok');
    });
    await pool.query('UPDATE monitors SET url = $2 WHERE id = $1', [id, localUrl(port)]);

    const out = await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, { policy: permissive(port) });

    expect(out.status).toBe('recorded'); // not a timeout failure
    expect(writeDuringCheck).toBeLessThan(500);
    expect((await monitorRow(id)).description).toBe('edited-during-check');
  });
});