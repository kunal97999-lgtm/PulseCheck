import { z } from 'zod';

const paging = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['open', 'resolved']).optional(),
};

export const listIncidentsQuerySchema = z.object({
  ...paging,
  monitorId: z.string().uuid('Invalid monitor id').optional(),
});

export const monitorIncidentsQuerySchema = z.object(paging);

export const incidentIdParamsSchema = z.object({
  id: z.string().uuid('Invalid incident id'),
});