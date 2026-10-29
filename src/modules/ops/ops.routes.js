import { Router } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '../../utils/errors.js';

// Hashing both sides gives equal-length buffers, which timingSafeEqual requires,
// and avoids leaking the token's length.
const digest = (s) => createHash('sha256').update(s).digest();

export function requireOpsToken(expected) {
  const want = digest(expected);
  return (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m || !timingSafeEqual(digest(m[1]), want)) return next(new UnauthorizedError());
    next();
  };
}

export function createOpsRouter({ token, collect, limiter }) {
  const router = Router();
  router.use(limiter); // counts failed attempts per IP, before the token check
  router.use(requireOpsToken(token));

  router.get('/status', async (req, res) => {
    const status = await collect();
    res.set('Cache-Control', 'no-store');
    res.status(status.status === 'down' ? 503 : 200).json({ data: status });
  });

  return router;
}