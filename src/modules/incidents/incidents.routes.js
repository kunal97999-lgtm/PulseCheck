import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { listIncidentsQuerySchema, incidentIdParamsSchema } from './incidents.schemas.js';
import { list, getOne } from './incidents.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/', validate(listIncidentsQuerySchema, 'query'), list);
router.get('/:id', validate(incidentIdParamsSchema, 'params'), getOne);

export default router;