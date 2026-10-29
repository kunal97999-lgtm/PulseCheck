import { logger } from '../utils/logger.js';

const PRUNE_MS = 3_600_000; // forget workers silent for an hour

export const heartbeatKey = (prefix) => `${prefix}:workers`;

export async function recordBeat(redis, prefix, workerId, now = Date.now()) {
  await redis.zadd(heartbeatKey(prefix), now, workerId);
  await redis.zremrangebyscore(heartbeatKey(prefix), 0, now - PRUNE_MS);
}

/** Workers whose last beat is within `staleMs` of `now`. */
export function countLiveWorkers(redis, prefix, { now = Date.now(), staleMs }) {
  return redis.zcount(heartbeatKey(prefix), now - staleMs, '+inf');
}

export function startHeartbeat({ redis, prefix, workerId, intervalMs, onBeat }) {
  let inFlight = Promise.resolve();

  const beat = () => {
    inFlight = recordBeat(redis, prefix, workerId)
      .then(() => onBeat?.())
      .catch((err) => {
        logger.warn({ err: { code: err?.code, message: err?.message } }, 'Heartbeat failed');
      });
    return inFlight;
  };

  beat();
  const timer = setInterval(beat, intervalMs);

  return {
    async stop() {
      clearInterval(timer);
      await inFlight; // a late beat must not re-add us after the removal below
      await redis.zrem(heartbeatKey(prefix), workerId).catch(() => {});
    },
  };
}