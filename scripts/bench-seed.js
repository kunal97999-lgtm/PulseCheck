import { pool, closePool } from '../src/db/pool.js';

const MONITORS = Number(process.argv[2] ?? 20);
const ROWS = Number(process.argv[3] ?? 50000); // 50,000 one-minute checks is about 35 days

const existing = await pool.query(`SELECT count(*)::int AS n FROM monitors WHERE name LIKE 'bench-%'`);
if (existing.rows[0].n > 0) {
  console.error('Benchmark monitors already exist. Run: npm run bench:clean');
  await closePool();
  process.exit(1);
}

const { rows: [user] } = await pool.query(
  `INSERT INTO users (email, password_hash) VALUES ('bench@example.com', 'x')
   ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
);

for (let i = 1; i <= MONITORS; i++) {
  const name = `bench-${String(i).padStart(2, '0')}`;
  const { rows: [m] } = await pool.query(
    `INSERT INTO monitors (user_id, name, url, is_active)
     VALUES ($1, $2, 'https://bench.invalid/', false) RETURNING id`,
    [user.id, name],
  );
  // One statement per monitor keeps each under the pool's 15s query timeout.
  await pool.query(
    `INSERT INTO check_results
       (monitor_id, scheduled_for, checked_at, success, status_code, latency_ms, error_type, error_message)
     SELECT $1::uuid, s.ts, s.ts + interval '1 second', s.ok,
            CASE WHEN s.ok THEN 200 ELSE 503 END,
            (50 + random() * 200)::int,
            CASE WHEN s.ok THEN NULL ELSE 'http_status' END,
            CASE WHEN s.ok THEN NULL ELSE 'Unexpected status code 503 (expected 200-299)' END
       FROM (SELECT now() - (g * interval '60 seconds') AS ts, random() > 0.02 AS ok
               FROM generate_series(1, $2::int) g) s`,
    [m.id, ROWS],
  );
  console.log(`seeded ${name}: ${ROWS} rows`);
}

await pool.query('ANALYZE check_results'); // without fresh statistics the planner's choices mean nothing
await pool.query('ANALYZE monitors');
console.log('done');
await closePool();