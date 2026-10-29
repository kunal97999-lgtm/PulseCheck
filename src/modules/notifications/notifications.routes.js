import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { listNotificationsQuerySchema, updatePreferencesSchema } from './notifications.schemas.js';
import { list, getPrefs, patchPrefs } from './notifications.controller.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);
notificationsRouter.get('/', validate(listNotificationsQuerySchema, 'query'), list);

export const preferencesRouter = Router();
preferencesRouter.use(requireAuth);
preferencesRouter.get('/', getPrefs);
preferencesRouter.patch('/', validate(updatePreferencesSchema), patchPrefs);