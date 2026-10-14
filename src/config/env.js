import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(168),
  AUTH_LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(10),
  AUTH_LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  REGISTER_MAX_PER_WINDOW: z.coerce.number().int().min(1).default(5),
  REGISTER_WINDOW_MINUTES: z.coerce.number().int().min(1).default(60),
  MAX_MONITORS_PER_USER: z.coerce.number().int().min(1).default(20),  
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('\n  ');
  console.error(`Invalid environment configuration:\n  ${problems}`);
  process.exit(1);
}

export const env = parsed.data;