import { randomUUID } from 'node:crypto';
import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './utils/logger.js';
import { pool } from './db/pool.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import monitorRoutes from './modules/monitors/monitors.routes.js';
import { createAuthLimiters } from './middleware/rateLimit.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

export function createApp({ rateLimits } = {}) {
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

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/ready', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ready' });
    } catch (err) {
      req.log.error({ err }, 'Readiness check failed');
      res.status(503).json({ status: 'not_ready' });
    }
  });

  const authLimiters = createAuthLimiters(rateLimits);
  app.use('/api/auth', createAuthRouter(authLimiters));
  app.use('/api/monitors', monitorRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}