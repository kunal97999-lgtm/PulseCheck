import { describe, it, expect } from 'vitest';
import { nextMonitorState } from '../../src/modules/checks/monitorState.js';

const base = {
  current_status: 'pending',
  consecutive_failures: 0,
  consecutive_successes: 0,
  failure_threshold: 3,
  recovery_threshold: 1,
};
const m = (over) => ({ ...base, ...over });

describe('nextMonitorState', () => {
  it('first success on a pending monitor makes it up (recovery_threshold 1)', () => {
    expect(nextMonitorState(m({}), true)).toEqual({
      status: 'up', consecutiveFailures: 0, consecutiveSuccesses: 1,
    });
  });

  it('failures below the threshold leave the status alone', () => {
    expect(nextMonitorState(m({ current_status: 'up' }), false)).toEqual({
      status: 'up', consecutiveFailures: 1, consecutiveSuccesses: 0,
    });
    expect(nextMonitorState(m({}), false).status).toBe('pending');
  });

  it('the failure that reaches the threshold makes it down', () => {
    const s = nextMonitorState(m({ current_status: 'up', consecutive_failures: 2 }), false);
    expect(s).toEqual({ status: 'down', consecutiveFailures: 3, consecutiveSuccesses: 0 });
  });

  it('keeps counting failures past the threshold and stays down', () => {
    const s = nextMonitorState(m({ current_status: 'down', consecutive_failures: 5 }), false);
    expect(s).toMatchObject({ status: 'down', consecutiveFailures: 6 });
  });

  it('a success resets failures and recovers a down monitor', () => {
    const s = nextMonitorState(m({ current_status: 'down', consecutive_failures: 5 }), true);
    expect(s).toEqual({ status: 'up', consecutiveFailures: 0, consecutiveSuccesses: 1 });
  });

  it('a failure resets the success streak', () => {
    const s = nextMonitorState(m({ current_status: 'up', consecutive_successes: 4 }), false);
    expect(s.consecutiveSuccesses).toBe(0);
  });

  it('honors recovery_threshold > 1', () => {
    const cfg = { current_status: 'down', consecutive_failures: 5, recovery_threshold: 2 };
    const first = nextMonitorState(m(cfg), true);
    expect(first.status).toBe('down'); // one success is not enough
    const second = nextMonitorState(
      m({ ...cfg, consecutive_failures: 0, consecutive_successes: first.consecutiveSuccesses }),
      true,
    );
    expect(second.status).toBe('up');
  });

  it('honors failure_threshold of 1', () => {
    expect(nextMonitorState(m({ failure_threshold: 1 }), false).status).toBe('down');
  });

  it('does not mutate its input', () => {
    const input = m({});
    nextMonitorState(input, false);
    expect(input).toEqual(base);
  });
});