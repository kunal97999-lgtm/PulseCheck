import autocannon from 'autocannon';
import { pool, closePool } from '../src/db/pool.js';

const BASE = process.env.LOAD_BASE_URL ?? 'http://localhost:3000';
const EMAIL = 'load-test@example.com';
const PASSWORD = 'load-test-password-123';
const ROWS = Number(process.env.LOAD_ROWS ?? 50000);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 15);
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS ?? 10);

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function cleanup() {
  await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]); // cascades to everything
}

try {
  await cleanup(); // a previous aborted run
  const reg = await api('POST', '/api/auth/register', { body: { email: EMAIL, password: PASSWORD } });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} (register limit is 5/hour per IP)`);
  const login = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  const token = login.json.data.token;

  const created = await api('POST', '/api/monitors', {
    token,
    body: { name: 'load', url: 'https://load.invalid/health' },
  });
  const monitorId = created.json.data.monitor.id;
  await api('POST', `/api/monitors/${monitorId}/pause`, { token }); // the worker must never touch it

  await pool.query(
    `INSERT INTO check_results
       (monitor_id, scheduled_for, checked_at, success, status_code, latency_ms, error_type, error_message)
     SELECT $1::uuid, s.ts, s.ts + interval '1 second', s.ok,
            CASE WHEN s.ok THEN 200 ELSE 503 END, (50 + random() * 200)::int,
            CASE WHEN s.ok THEN NULL ELSE 'http_status' END,
            CASE WHEN s.ok THEN NULL ELSE 'bad' END
       FROM (SELECT now() - (g * interval '60 seconds') AS ts, random() > 0.02 AS ok
               FROM generate_series(1, $2::int) g) s`,
    [monitorId, ROWS],
  );
  await pool.query('ANALYZE check_results');

  const from30 = new Date(Date.now() - 29 * 86_400_000).toISOString();
  const scenarios = [
    ['GET /health (no DB, no auth)', '/health', false],
    ['GET /api/monitors (auth + list)', '/api/monitors', true],
    ['GET .../checks?limit=50', `/api/monitors/${monitorId}/checks?limit=50`, true],
    ['GET .../stats (24h)', `/api/monitors/${monitorId}/stats`, true],
    ['GET .../stats (29 days)', `/api/monitors/${monitorId}/stats?from=${encodeURIComponent(from30)}`, true],
  ];

  const rows = [];
  for (const [name, path, authed] of scenarios) {
    const r = await autocannon({
      url: `${BASE}${path}`,
      connections: CONNECTIONS,
      duration: SECONDS,
      headers: authed ? { Authorization: `Bearer ${token}` } : {},
    });
    rows.push({
      scenario: name,
      'req/s avg': Math.round(r.requests.average),
      'p50 ms': r.latency.p50,
      'p97.5 ms': r.latency.p97_5,
      'p99 ms': r.latency.p99,
      'max ms': r.latency.max,
      non2xx: r.non2xx,
      errors: r.errors,
      timeouts: r.timeouts,
    });
  }
  console.table(rows);
  console.log(`data: ${ROWS} check rows, ${CONNECTIONS} connections, ${SECONDS}s per scenario`);
} finally {
  await cleanup();
  await closePool();
}