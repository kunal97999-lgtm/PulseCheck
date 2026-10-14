import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

function buildLimiter({ windowMs, limit, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit,
    skipSuccessfulRequests, // when true, only responses with status >= 400 count
    standardHeaders: 'draft-7', // RateLimit / RateLimit-Policy headers
    legacyHeaders: false,
    // Route through our central error handler so the format stays consistent.
    handler: (req, res, next, options) => {
      const resetTime = req.rateLimit?.resetTime;
      const seconds = resetTime
        ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(options.windowMs / 1000);
      res.set('Retry-After', String(seconds));
      next(new AppError(429, 'RATE_LIMITED', 'Too many requests, please try again later'));
    },
  });
}


export function createAuthLimiters(overrides = {}) {
  const cfg = {
    loginMaxFailures: env.AUTH_LOGIN_MAX_FAILURES,
    loginWindowMs: env.AUTH_LOGIN_WINDOW_MINUTES * 60_000,
    registerMax: env.REGISTER_MAX_PER_WINDOW,
    registerWindowMs: env.REGISTER_WINDOW_MINUTES * 60_000,
    ...overrides,
  };

  return {
    login: buildLimiter({
      windowMs: cfg.loginWindowMs,
      limit: cfg.loginMaxFailures,
      skipSuccessfulRequests: true,
    }),
    register: buildLimiter({
      windowMs: cfg.registerWindowMs,
      limit: cfg.registerMax,
    }),
  };
}