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
let onRequest = async () => {};
async function startServer() {
  const server = http.createServer(async (req, res) => {
    await onRequest();
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server.address().port;
}
afterEach(async () => {
  onRequest = async () => {};
  while (servers.length) {
    const s = servers.pop();
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
});

const permissive = (port) => ({ isBlockedIp: () => false, allowedPorts: new Set(['', String(port)]) });
const slot = (n) => new Date(Date.UTC(2026, 0, 1, 0, n));
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function newMonitor(port) {
  const { token } = await registerAndLogin(app);
  const res = await request(app)
    .post('/api/monitors')
    .set(bearer(token))
    .send({ name: 'm', url: 'https://api.example.com/health', timeoutMs: 3000 })
    .expect(201);
  const id = res.body.data.monitor.id;
  await pool.query('UPDATE monitors SET url = $2 WHERE id = $1', [id, `http://127.0.0.1:${port}/`]);
  return { id, token };
}
const row = async (id) => (await pool.query('SELECT * FROM monitors WHERE id = $1', [id])).rows[0];
const results = async (id) =>
  (await pool.query('SELECT * FROM check_results WHERE monitor_id = $1', [id])).rows;
const patch = (token, id, body) =>
  request(app).patch(`/api/monitors/${id}`).set(bearer(token)).send(body);
const post = (token, id, suffix) =>
  request(app).post(`/api/monitors/${id}/${suffix}`).set(bearer(token));

describe('config_version bumps exactly when state is reset', () => {
  it('URL change and resume-from-pause bump it; rename and no-op resume do not', async () => {
    const port = await startServer();
    const { id, token } = await newMonitor(port);
    expect((await row(id)).config_version).toBe(1);

    await patch(token, id, { name: 'renamed' }).expect(200);
    await patch(token, id, { timeoutMs: 5000 }).expect(200);
    expect((await row(id)).config_version).toBe(1);

    await patch(token, id, { url: 'https://other.example.com/' }).expect(200);
    expect((await row(id)).config_version).toBe(2);

    await post(token, id, 'resume').expect(200); // already active: no-op
    expect((await row(id)).config_version).toBe(2);

    await post(token, id, 'pause').expect(200);
    expect((await row(id)).config_version).toBe(2); // pausing alone doesn't reset anything
    await post(token, id, 'resume').expect(200);
    expect((await row(id)).config_version).toBe(3);
  });
});

describe('results from an outdated configuration are discarded', () => {
  it('records normally when nothing changes during the check', async () => {
    const port = await startServer();
    const { id } = await newMonitor(port);
    const out = await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, { policy: permissive(port) });
    expect(out.status).toBe('recorded');
    expect(await results(id)).toHaveLength(1);
  });

  it('discards the result when the URL is changed DURING the check', async () => {
    const port = await startServer();
    const { id, token } = await newMonitor(port);
    onRequest = async () => {
      await patch(token, id, { url: 'https://other.example.com/' }).expect(200);
    };

    const out = await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, { policy: permissive(port) });

    expect(out.status).toBe('stale_config');
    expect(await results(id)).toHaveLength(0); // not in the new URL's history
    expect(await row(id)).toMatchObject({
      current_status: 'pending', consecutive_successes: 0, last_checked_at: null,
    });
  });

  it('discards the result when the monitor is paused and resumed DURING the check', async () => {
    const port = await startServer();
    const { id, token } = await newMonitor(port);
    onRequest = async () => {
      await post(token, id, 'pause').expect(200);
      await post(token, id, 'resume').expect(200);
    };

    const out = await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, { policy: permissive(port) });
    expect(out.status).toBe('stale_config');
    expect(await results(id)).toHaveLength(0);
  });

  it('still records when only a harmless field (the name) changes during the check', async () => {
    const port = await startServer();
    const { id, token } = await newMonitor(port);
    onRequest = async () => {
      await patch(token, id, { name: 'renamed-mid-check' }).expect(200);
    };

    const out = await checkAndRecord({ monitorId: id, scheduledFor: slot(0) }, { policy: permissive(port) });
    expect(out.status).toBe('recorded');
    expect(await results(id)).toHaveLength(1);
  });
});