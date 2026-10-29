import { z } from 'zod';

export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(),
});

export const updatePreferencesSchema = z
  .object({
    emailOnOpen: z.boolean().optional(),
    emailOnResolve: z.boolean().optional(),
  })
  .strict() // unknown fields are an error
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one field is required' });