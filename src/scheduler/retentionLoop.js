import { logger } from '../utils/logger.js';

/**
 * Runs `run()` every `intervalMs` (first run after one interval, so a restart
 * doesn't start with a heavy delete). Errors never kill the loop.
 * Several worker processes may run this: batches use SKIP LOCKED, so it's safe.
 */
export function startRetentionLoop({ intervalMs, run }) {
  let stopped = false;
  let timer = null;
  let running = null;

  async function tick() {
    try {
      const summary = await run();
      logger.info({ summary }, 'Retention pass finished');
    } catch (err) {
      logger.error({ err }, 'Retention pass failed');
    }
    schedule();
  }

  function schedule() {
    if (!stopped) timer = setTimeout(() => { running = tick(); }, intervalMs);
  }

  schedule();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}