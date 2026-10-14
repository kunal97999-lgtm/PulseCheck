import { describe, it, expect } from 'vitest';
import { generateToken, hashToken } from '../../src/modules/auth/tokens.js';

describe('tokens', () => {
  it('generates 43-character URL-safe tokens', () => {
    expect(generateToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generates a different token every time', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateToken));
    expect(tokens.size).toBe(100);
  });

  it('hashes deterministically with SHA-256 (known test vector)', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('never returns the token itself as its hash', () => {
    const token = generateToken();
    expect(hashToken(token)).not.toBe(token);
    expect(hashToken(token)).toHaveLength(64);
  });
});