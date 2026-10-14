import { z } from 'zod';

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

const urlSchema = z
  .string()
  .trim()
  .max(2048, 'URL must be at most 2048 characters')
  .transform((value, ctx) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Must be a valid URL' });
      return z.NEVER;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'URL must use http or https' });
      return z.NEVER;
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: 'custom', message: 'URL must not contain credentials' });
      return z.NEVER;
    }
    if (!ALLOWED_PORTS.has(url.port)) {
      ctx.addIssue({ code: 'custom', message: 'Port must be 80, 443, 8080, or 8443' });
      return z.NEVER;
    }
    url.hash = ''; // fragments are never sent to servers; don't store them
    return url.toString();
  });

export const createMonitorSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100),
    description: z.string().trim().max(500).optional(),
    url: urlSchema,
    intervalSeconds: z.number().int().min(60).max(86400).default(300),
    timeoutMs: z.number().int().min(1000).max(30000).default(10000),
    expectedStatusMin: z.number().int().min(100).max(599).default(200),
    expectedStatusMax: z.number().int().min(100).max(599).default(299),
    failureThreshold: z.number().int().min(1).max(10).default(3),
    recoveryThreshold: z.number().int().min(1).max(10).default(1),
  })
  .strict() // unknown fields are an error, not silently ignored
  .refine((d) => d.expectedStatusMin <= d.expectedStatusMax, {
    message: 'expectedStatusMin must be less than or equal to expectedStatusMax',
    path: ['expectedStatusMin'],
  });

export const monitorIdParamsSchema = z.object({
  id: z.string().uuid('Invalid monitor id'),
});

export const listMonitorsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});