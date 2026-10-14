import { pool } from '../../db/pool.js';

const UNIQUE_VIOLATION = '23505';

export async function createUser({ email, passwordHash }, db = pool) {
  try {
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, created_at`,
      [email, passwordHash],
    );
    return rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === 'users_email_unique') {
      return null;
    }
    throw err;
  }
}

export async function findUserByEmail(email, db = pool) {
  const { rows } = await db.query(
    `SELECT id, email, password_hash, created_at FROM users WHERE email = $1`,
    [email],
  );
  return rows[0] ?? null;
}

export async function createSession({ userId, tokenHash, ttlHours }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 hour'))
     RETURNING id, expires_at`,
    [userId, tokenHash, ttlHours],
  );
  return rows[0];
}

export async function findActiveSession(tokenHash, db = pool) {
  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.expires_at,
            u.id AS user_id, u.email, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function deleteSession(sessionId, db = pool) {
  await db.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}