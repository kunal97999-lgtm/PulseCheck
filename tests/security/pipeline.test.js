import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { checkAndRecord } from '../../src/modules/checks/checkAndRecord.js';
import { useTestDb } from '../helpers/db.js';
import { registerAndLogin } from '../helpers/auth.js';

useTestDb();
const app = createApp();
const slot = new Date('2026-01-01T00:00:00.000Z');

async function createMonitor(url) {
  const { token } = await registerAndLogin(app);
  const res = await request(app)
    .post('/api/monitors')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'm', url });
  return res;
}
const rows = async (id) =>
  (await pool.query('SELECT * FROM check_results WHERE monitor_id = $1', [id])).rows;

describe('creation validates shape; the check enforces policy', () => {
  it.each([
    ['private IP literal', 'http://10.0.0.5/admin'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['obfuscated loopback', 'http://2130706433/'],
  ])('%s: accepted at creation, blocked at check time', async (_n, url) => {
    const res = await createMonitor(url);
    expect(res.status).toBe(201); // documents the current design on purpose
    const id = res.body.data.monitor.id;

    // No deps: the production policy applies, and nothing can be sent.
    const out = await checkAndRecord({ monitorId: id, scheduledFor: slot });
    expect(out.result).toMatchObject({ success: false, errorType: 'blocked', latencyMs: null });

    const [row] = await rows(id);
    expect(row.error_message).toBe('Target is not permitted by security policy');
    expect(JSON.stringify(row)).not.toMatch(/10\.0\.0\.5|169\.254|127\.0\.0\.1/);
  });

  it('a hostname that resolves to a private address is blocked at check time', async () => {
    const res = await createMonitor('http://rebind.example.com/health');
    const id = res.body.data.monitor.id;
    const lookup = async () => [{ address: '10.0.0.5', family: 4 }]; // fake DNS, no network

    const out = await checkAndRecord({ monitorId: id, scheduledFor: slot }, { lookup });
    expect(out.result.errorType).toBe('blocked');
  });

  it('a blocked monitor still counts toward going down (documented behavior)', async () => {
    const id = (await createMonitor('http://10.0.0.5/')).body.data.monitor.id;
    for (let i = 0; i < 3; i++) {
      await checkAndRecord({ monitorId: id, scheduledFor: new Date(slot.getTime() + i * 60_000) });
    }
    const { rows: m } = await pool.query('SELECT current_status FROM monitors WHERE id = $1', [id]);
    expect(m[0].current_status).toBe('down');
  });
});