import { z } from 'zod';

const isoDate = z.string().datetime({ offset: true }).transform((s) => new Date(s));

export const statsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});