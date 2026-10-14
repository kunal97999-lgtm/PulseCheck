import { describe, it, expect } from 'vitest';
import { registerSchema } from '../../src/modules/auth/auth.schemas.js';

const good = { email: 'alice@example.com', password: 'correct-horse-battery' };

describe('registerSchema', () => {
  it('trims and lowercases the email', () => {
    const r = registerSchema.parse({ ...good, email: '  Alice@Example.COM ' });
    expect(r.email).toBe('alice@example.com');
  });

  it('rejects an invalid email', () => {
    expect(registerSchema.safeParse({ ...good, email: 'nope' }).success).toBe(false);
  });

  it('enforces the 10-character minimum boundary', () => {
    expect(registerSchema.safeParse({ ...good, password: 'a'.repeat(9) }).success).toBe(false);
    expect(registerSchema.safeParse({ ...good, password: 'a'.repeat(10) }).success).toBe(true);
  });

  it('enforces the 72-BYTE limit boundary', () => {
    expect(registerSchema.safeParse({ ...good, password: 'a'.repeat(72) }).success).toBe(true);
    expect(registerSchema.safeParse({ ...good, password: 'a'.repeat(73) }).success).toBe(false);
  });

  it('counts bytes, not characters', () => {
    // 37 characters but 74 bytes in UTF-8
    expect(registerSchema.safeParse({ ...good, password: 'é'.repeat(37) }).success).toBe(false);
  });
});