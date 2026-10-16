import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import {
  createMonitorSchema,
  updateMonitorSchema,
  monitorIdParamsSchema,
  listMonitorsQuerySchema,
} from './monitors.schemas.js';
import { create, getOne, list, update, pause, resume, remove } from './monitors.controller.js';

const router = Router();
const validId = validate(monitorIdParamsSchema, 'params');

router.use(requireAuth); // every monitor route requires a valid session

router.post('/', validate(createMonitorSchema), create);
router.get('/', validate(listMonitorsQuerySchema, 'query'), list);
router.get('/:id', validId, getOne);
router.patch('/:id', validId, validate(updateMonitorSchema), update);
router.delete('/:id', validId, remove);
router.post('/:id/pause', validId, pause);
router.post('/:id/resume', validId, resume);

export default router;