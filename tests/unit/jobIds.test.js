import { describe, it, expect } from 'vitest';
import { slotJobId } from '../../src/scheduler/tick.js';

describe('slotJobId', () => {
  it('is deterministic: same monitor and slot give the same id', () => {
    const slot = new Date('2026-01-01T00:00:00.000Z');
    expect(slotJobId('abc', slot)).toBe(slotJobId('abc', new Date(slot.getTime())));
  });

  it('differs per monitor and per slot', () => {
    expect(slotJobId('a', new Date(1000))).not.toBe(slotJobId('b', new Date(1000)));
    expect(slotJobId('a', new Date(1000))).not.toBe(slotJobId('a', new Date(2000)));
  });

  it('has the expected format and no colon (BullMQ forbids it in custom ids)', () => {
    expect(slotJobId('abc', new Date(1000))).toBe('abc_1000');
  });
});