import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { registerSchema, loginSchema } from './auth.schemas.js';
import { register, login, me, logout } from './auth.controller.js';

export function createAuthRouter(limiters) {
  const router = Router();

  router.post('/register', limiters.register, validate(registerSchema), register);
  router.post('/login', limiters.login, validate(loginSchema), login);
  router.get('/me', requireAuth, me);
  router.post('/logout', requireAuth, logout);

  return router;
}