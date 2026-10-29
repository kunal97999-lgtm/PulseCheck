SELECT id AS mid FROM monitors WHERE name = 'bench-01' \gset
SELECT checked_at AS cts, id AS cid FROM check_results WHERE monitor_id = :'mid' ORDER BY checked_at DESC, id DESC OFFSET 49 LIMIT 1 \gset

\echo === A. history, first page (latest 50)
EXPLAIN (ANALYZE, BUFFERS) SELECT id, checked_at, success, status_code, latency_ms, error_type FROM check_results WHERE monitor_id = :'mid' ORDER BY checked_at DESC, id DESC LIMIT 50;

\echo === B. history, next page (keyset cursor)
EXPLAIN (ANALYZE, BUFFERS) SELECT id, checked_at, success, status_code, latency_ms, error_type FROM check_results WHERE monitor_id = :'mid' AND (checked_at, id) < (:'cts'::timestamptz, :cid) ORDER BY checked_at DESC, id DESC LIMIT 50;

\echo === C1. stats, 24 hours
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) AS total, count(*) FILTER (WHERE success) AS ok, avg(latency_ms) FILTER (WHERE success) AS avg_ms, percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE success) AS p95_ms FROM check_results WHERE monitor_id = :'mid' AND checked_at >= now() - interval '24 hours' AND checked_at < now();

\echo === C2. stats, 7 days
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) AS total, count(*) FILTER (WHERE success) AS ok, avg(latency_ms) FILTER (WHERE success) AS avg_ms, percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE success) AS p95_ms FROM check_results WHERE monitor_id = :'mid' AND checked_at >= now() - interval '7 days' AND checked_at < now();

\echo === C3. stats, 30 days
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) AS total, count(*) FILTER (WHERE success) AS ok, avg(latency_ms) FILTER (WHERE success) AS avg_ms, percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE success) AS p95_ms FROM check_results WHERE monitor_id = :'mid' AND checked_at >= now() - interval '30 days' AND checked_at < now();

\echo === sizes
SELECT indexrelid::regclass AS index, pg_size_pretty(pg_relation_size(indexrelid)) AS size FROM pg_index WHERE indrelid = 'check_results'::regclass;
SELECT pg_size_pretty(pg_relation_size('check_results')) AS table_size;