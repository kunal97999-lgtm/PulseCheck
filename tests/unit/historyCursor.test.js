import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/modules/checks/history.cursor.js';
import { ValidationError } from '../../src/utils/errors.js';

const b64 = (s) => Buffer.from(s).toString('base64url');
const row = { cursor_ts: '2026-01-01T00:00:00.000123Z', id: '42' };

describe('cursor', () => {
  it('round-trips, preserving microseconds', () => {
    expect(decodeCursor(encodeCursor(row))).toEqual({ ts: '2026-01-01T00:00:00.000123Z', id: '42' });
  });

  it('is opaque: no plain timestamp or id visible', () => {
    expect(encodeCursor(row)).not.toMatch(/2026|42/);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['not JSON', b64('hello')],
    ['null', b64('null')],
    ['missing fields', b64('{"t":"2026-01-01T00:00:00.000000Z"}')],
    ['numeric id', b64('{"t":"2026-01-01T00:00:00.000000Z","i":1}')],
    ['SQL in the id', b64('{"t":"2026-01-01T00:00:00.000000Z","i":"1; DROP TABLE users"}')],
    ['id too long', b64(`{"t":"2026-01-01T00:00:00.000000Z","i":"${'9'.repeat(19)}"}`)],
    ['wrong timestamp format', b64('{"t":"2026-01-01","i":"1"}')],
    ['impossible month', b64('{"t":"2026-13-01T00:00:00.000000Z","i":"1"}')],
  ])('rejects %s with a ValidationError', (_n, token) => {
    expect(() => decodeCursor(token)).toThrow(ValidationError);
  });
});