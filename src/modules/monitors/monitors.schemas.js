import { z } from 'zod';
import { ALLOWED_PORTS } from '../checks/ssrf/targetPolicy.js';
// Documented port policy. new URL() reports default ports (80 for http, 443 for https) as ''.
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

// Single source of truth for field rules (no defaults here).
const fields = {
  name: z.string().trim().min(1, 'Name is required').max(100),
  description: z.string().trim().max(500),
  url: urlSchema,
  intervalSeconds: z.number().int().min(60).max(86400),
  timeoutMs: z.number().int().min(1000).max(30000),
  expectedStatusMin: z.number().int().min(100).max(599),
  expectedStatusMax: z.number().int().min(100).max(599),
  failureThreshold: z.number().int().min(1).max(10),
  recoveryThreshold: z.number().int().min(1).max(10),
};

export const createMonitorSchema = z
  .object({
    name: fields.name,
    description: fields.description.optional(),
    url: fields.url,
    intervalSeconds: fields.intervalSeconds.default(300),
    timeoutMs: fields.timeoutMs.default(10000),
    expectedStatusMin: fields.expectedStatusMin.default(200),
    expectedStatusMax: fields.expectedStatusMax.default(299),
    failureThreshold: fields.failureThreshold.default(3),
    recoveryThreshold: fields.recoveryThreshold.default(1),
  })
  .strict() // unknown fields are an error, not silently ignored
  .refine((d) => d.expectedStatusMin <= d.expectedStatusMax, {
    message: 'expectedStatusMin must be less than or equal to expectedStatusMax',
    path: ['expectedStatusMin'],
  });

// Every field optional, NO defaults: an omitted field must stay omitted so the
// service knows to keep the stored value. `description: null` clears it.
export const updateMonitorSchema = z
  .object({
    name: fields.name.optional(),
    description: fields.description.nullable().optional(),
    url: fields.url.optional(),
    intervalSeconds: fields.intervalSeconds.optional(),
    timeoutMs: fields.timeoutMs.optional(),
    expectedStatusMin: fields.expectedStatusMin.optional(),
    expectedStatusMax: fields.expectedStatusMax.optional(),
    failureThreshold: fields.failureThreshold.optional(),
    recoveryThreshold: fields.recoveryThreshold.optional(),
  })
  .strict() // isActive, status, userId, etc. are rejected: pause/resume are separate endpoints
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one field is required' });

export const monitorIdParamsSchema = z.object({
  id: z.string().uuid('Invalid monitor id'),
});

export const listMonitorsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});