-- Up Migration
CREATE INDEX check_results_monitor_checked_id_idx
  ON check_results (monitor_id, checked_at DESC, id DESC);
DROP INDEX check_results_monitor_checked_idx;

-- Down Migration
CREATE INDEX check_results_monitor_checked_idx ON check_results (monitor_id, checked_at DESC);
DROP INDEX check_results_monitor_checked_id_idx;