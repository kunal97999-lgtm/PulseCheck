import bcrypt from 'bcrypt';
import { env } from '../../config/env.js';
import { ConflictError, UnauthorizedError } from '../../utils/errors.js';
import * as authRepository from './auth.repository.js';
import { generateToken, hashToken } from './tokens.js';

export async function registerUser({ email, password }) {
  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
  const user = await authRepository.createUser({ email, passwordHash });
  if (!user) {
    throw new ConflictError('EMAIL_TAKEN', 'An account with this email already exists');
  }
  return user;
}

let dummyHashPromise;
function getDummyHash() {
  dummyHashPromise ??= bcrypt.hash('not-a-real-password', env.BCRYPT_ROUNDS);
  return dummyHashPromise;
}

export async function loginUser({ email, password }) {
  const user = await authRepository.findUserByEmail(email);
  const hashToCompare = user ? user.password_hash : await getDummyHash();
  const passwordOk = await bcrypt.compare(password, hashToCompare);

  if (!user || !passwordOk) {
    throw new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  const token = generateToken();
  const session = await authRepository.createSession({
    userId: user.id,
    tokenHash: hashToken(token),
    ttlHours: env.SESSION_TTL_HOURS,
  });

  return { token, expiresAt: session.expires_at, user };
}

export async function logout(sessionId) {
  await authRepository.deleteSession(sessionId);
}