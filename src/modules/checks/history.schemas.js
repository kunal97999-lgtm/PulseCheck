import { z } from 'zod';

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

export const listChecksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  success: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});