// Exits 0 if the worker wrote a heartbeat file recently, 1 otherwise.
import { readFileSync } from 'node:fs';

const MAX_AGE_MS = 45_000; // 4.5x the 10 s beat interval
try {
  const ts = Number(readFileSync(process.env.WORKER_HEALTH_FILE, 'utf8'));
  process.exit(Date.now() - ts < MAX_AGE_MS ? 0 : 1);
} catch {
  process.exit(1); // file missing: the worker hasn't completed a beat yet
}