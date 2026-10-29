
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

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  QUEUE_PREFIX: z.string().min(1).max(50).default('pulsecheck'),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(40000),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(100).default(5000),
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  CHECK_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  CHECK_JOB_BACKOFF_MS: z.coerce.number().int().min(10).default(2000),

  SMTP_HOST: z.string().min(1).default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().min(3).default('PulseCheck <alerts@pulsecheck.local>'),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  NOTIFICATION_BACKOFF_MS: z.coerce.number().int().min(10).default(5000),
  NOTIFICATION_LEASE_SECONDS: z.coerce.number().int().min(5).default(60),
  NOTIFICATION_SWEEP_MS: z.coerce.number().int().min(100).default(30000),
  NOTIFICATION_STALE_SECONDS: z.coerce.number().int().min(1).default(120),

  CHECK_RETENTION_DAYS: z.coerce.number().int().min(31).default(35),
  INCIDENT_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  RETENTION_INTERVAL_MS: z.coerce.number().int().min(1000).default(3_600_000),
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(50000).default(5000),
  RETENTION_MAX_BATCHES: z.coerce.number().int().min(1).default(200),
  USER_API_MAX_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  USER_WRITE_MAX_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  OPS_TOKEN: z.string().min(32).optional(),
  OPS_OVERDUE_SECONDS: z.coerce.number().int().min(30).default(300),
  OPS_NOTIFICATION_LAG_SECONDS: z.coerce.number().int().min(60).default(900),
  OPS_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(10000),
  OPS_WORKER_STALE_SECONDS: z.coerce.number().int().min(5).default(30),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
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
