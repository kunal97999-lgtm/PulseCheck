
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

function buildLimiter({
  windowMs,
  limit,
  skipSuccessfulRequests = false,
  requestWasSuccessful,
  store,
  keyGenerator,
  skip,
}) {
  return rateLimit({
    windowMs,
    limit,
    skipSuccessfulRequests,
    ...(requestWasSuccessful && { requestWasSuccessful }),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(keyGenerator && { keyGenerator }),
    ...(skip && { skip }),
    // Fail open if Redis is unavailable.
    ...(store && { store, passOnStoreError: true }),

    // Use the central error handler for consistent error responses.
    handler: (req, res, next, options) => {
      const resetTime = req.rateLimit?.resetTime;

      const seconds = resetTime
        ? Math.max(
            1,
            Math.ceil((resetTime.getTime() - Date.now()) / 1000),
          )
        : Math.ceil(options.windowMs / 1000);

      res.set('Retry-After', String(seconds));

      next(
        new AppError(
          429,
          'RATE_LIMITED',
          'Too many requests, please try again later',
        ),
      );
    },
  });
}

const storeFactory = (redis, keyPrefix) => (name) =>
  redis
    ? new RedisStore({
        sendCommand: (command, ...args) => redis.call(command, ...args),
        prefix: `${keyPrefix}:${name}:`,
      })
    : undefined;

/**
 * Per-IP limiters for login and registration.
 * A fresh limiter is created per call.
 * With Redis, counters are shared across instances.
 * Without Redis, the limiter uses in-memory storage.
 */
export function createAuthLimiters(overrides = {}, redis) {
  const { keyPrefix = `${env.QUEUE_PREFIX}:rl`, ...limits } = overrides;

  const cfg = {
    loginMaxFailures: env.AUTH_LOGIN_MAX_FAILURES,
    loginWindowMs: env.AUTH_LOGIN_WINDOW_MINUTES * 60_000,
    registerMax: env.REGISTER_MAX_PER_WINDOW,
    registerWindowMs: env.REGISTER_WINDOW_MINUTES * 60_000,
    ...limits,
  };

  const storeFor = storeFactory(redis, keyPrefix);

  return {
    login: buildLimiter({
      windowMs: cfg.loginWindowMs,
      limit: cfg.loginMaxFailures,
      skipSuccessfulRequests: true,
      store: storeFor('login'),
    }),

    register: buildLimiter({
      windowMs: cfg.registerWindowMs,
      limit: cfg.registerMax,
      store: storeFor('register'),
    }),
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);


export function createUserLimiters(overrides = {}, redis) {
  const { keyPrefix = `${env.QUEUE_PREFIX}:rl`, ...limits } = overrides;

  const cfg = {
    userApiMax: env.USER_API_MAX_PER_MINUTE,
    userWriteMax: env.USER_WRITE_MAX_PER_MINUTE,
    userWindowMs: 60_000,
    ...limits,
  };

  const storeFor = storeFactory(redis, keyPrefix);
  const keyGenerator = (req) => `u:${req.user.id}`;

  return {
    api: buildLimiter({
      windowMs: cfg.userWindowMs,
      limit: cfg.userApiMax,
      keyGenerator,
      store: storeFor('user-api'),
    }),

    writes: buildLimiter({
      windowMs: cfg.userWindowMs,
      limit: cfg.userWriteMax,
      keyGenerator,
      skip: (req) => SAFE_METHODS.has(req.method),
      store: storeFor('user-write'),
    }),
  };
}

export function createOpsLimiter(overrides = {}, redis) {
  const {
    keyPrefix = `${env.QUEUE_PREFIX}:rl`,
    opsMaxFailures = 20,
    opsWindowMs = 15 * 60_000,
  } = overrides;

  return buildLimiter({
    windowMs: opsWindowMs,
    limit: opsMaxFailures,
    skipSuccessfulRequests: true,                          // <-- add this
    requestWasSuccessful: (req, res) => res.statusCode !== 401,
    store: storeFactory(redis, keyPrefix)('ops'),
  });
}
