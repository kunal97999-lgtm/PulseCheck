import { randomBytes, createHash } from 'node:crypto';

/** 32 random bytes = 256 bits of entropy, encoded as 43 URL-safe characters. */
export function generateToken() {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is ever stored. The raw token exists in memory and in the client. */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}