import { randomUUID } from 'node:crypto';
import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './utils/logger.js';
import { pool } from './db/pool.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import monitorRoutes from './modules/monitors/monitors.routes.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import incidentRoutes from './modules/incidents/incidents.routes.js';
import { notificationsRouter, preferencesRouter } from './modules/notifications/notifications.routes.js';

import { requireAuth } from './middleware/auth.js';
import { createAuthLimiters, createUserLimiters,createOpsLimiter } from './middleware/rateLimit.js';
import { createOpsRouter } from './modules/ops/ops.routes.js';








function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('readiness check timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * `redis` (an ioredis connection) is passed by server.js. When omitted (most
 * tests), rate limits use in-memory counters and /ready checks only Postgres.
 */
export function createApp({ rateLimits, redis,ops } = {}) {
  const app = express();

  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
    }),
  );

  app.use(express.json({ limit: '100kb' }));

  // Liveness: is the process up? Must NOT depend on DB or Redis.
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness: can this instance serve traffic? Checks every dependency.
  app.get('/ready', async (req, res) => {
    try {
      const checks = [pool.query('SELECT 1')];
      if (redis) checks.push(redis.ping());
      await withTimeout(Promise.all(checks), 2000);
      res.status(200).json({ status: 'ready' });
    } catch (err) {
      req.log.error({ err }, 'Readiness check failed');
      // Don't reveal which dependency failed or why
      res.status(503).json({ status: 'not_ready' });
    }
  });

    const authLimiters = createAuthLimiters(rateLimits, redis);
  app.use('/api/auth', createAuthRouter(authLimiters));

  // Authenticate once, then limit per user. Router-level requireAuth becomes a no-op.
  const userLimiters = createUserLimiters(rateLimits, redis);
  const authed = [requireAuth, userLimiters.api, userLimiters.writes];
  app.use('/api/monitors', ...authed, monitorRoutes);
  app.use('/api/incidents', ...authed, incidentRoutes);
  app.use('/api/notifications', ...authed, notificationsRouter);
  app.use('/api/notification-preferences', ...authed, preferencesRouter);
  if (ops?.token) {
    app.use('/ops', createOpsRouter({
      token: ops.token,
      collect: ops.collect,
      limiter: createOpsLimiter(rateLimits, redis),
    }));
  }
  // Order matters: these two must come after ALL routes.
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}