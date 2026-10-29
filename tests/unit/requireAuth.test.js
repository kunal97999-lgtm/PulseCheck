import { describe, it, expect, vi } from 'vitest';
import { requireAuth } from '../../src/middleware/auth.js';

describe('requireAuth', () => {
  it('is a no-op when the request was already authenticated (no second lookup)', async () => {
    const next = vi.fn();
    await requireAuth({ user: { id: 'u1' }, headers: {} }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no error
  });

  it('still rejects an unauthenticated request', async () => {
    const next = vi.fn();
    await requireAuth({ headers: {} }, {}, next);
    expect(next.mock.calls[0][0].status).toBe(401);
  });
});