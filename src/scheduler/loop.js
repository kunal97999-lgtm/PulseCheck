import { runSchedulerTick } from './tick.js';
import { logger } from '../utils/logger.js';

/**
 * Runs ticks forever, one at a time (setTimeout recursion, not setInterval,
 * so a slow tick can never overlap the next one).
 * Returns { stop() }, which resolves after any in-progress tick finishes.
 */
export function startScheduler({ queue, tickMs, batchSize }) {
  let stopped = false;
  let timer = null;
  let running = null;

  async function loop() {
    let delay = tickMs;
    try {
      const { enqueued } = await runSchedulerTick({ queue, batchSize });
      if (enqueued > 0) logger.debug({ enqueued }, 'Scheduler enqueued checks');
      if (enqueued === batchSize) delay = 0; // batch was full: more may be waiting
    } catch (err) {
      // Never let one bad tick (Redis or Postgres down) kill the loop.
      logger.error({ err }, 'Scheduler tick failed');
    }
    if (!stopped) {
      timer = setTimeout(() => {
        running = loop();
      }, delay);
    }
  }

  running = loop();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}