import { UnauthorizedError } from '../utils/errors.js';
import { hashToken } from '../modules/auth/tokens.js';
import * as authRepository from '../modules/auth/auth.repository.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

export async function requireAuth(req, res, next) {
  if (req.user) return next();
  const match = BEARER.exec(req.headers.authorization ?? '');
  if (!match) {
    return next(new UnauthorizedError());
  }

  const session = await authRepository.findActiveSession(hashToken(match[1]));
  if (!session) {
    return next(new UnauthorizedError());
  }

  req.user = { id: session.user_id, email: session.email, createdAt: session.created_at };
  req.sessionId = session.session_id;
  next();
}