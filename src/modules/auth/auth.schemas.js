import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254),
  password: z
    .string()
    .min(10, 'Password must be at least 10 characters')
    .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes'),
});

// Login does not re-enforce the registration rules. We only bound the size
// so nobody can send a megabyte-long "password" to burn CPU.
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1, 'Password is required').max(128),
});