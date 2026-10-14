import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  createMonitorSchema,
  monitorIdParamsSchema,
  listMonitorsQuerySchema,
} from './monitors.schemas.js';
import { create, getOne, list } from './monitors.controller.js';

const router = Router();

router.use(requireAuth); // every monitor route requires a valid session

router.post('/', validate(createMonitorSchema), create);
router.get('/', validate(listMonitorsQuerySchema, 'query'), list);
router.get('/:id', validate(monitorIdParamsSchema, 'params'), getOne);

export default router;