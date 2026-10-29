import { describe, it, expect } from 'vitest';
import { classifyMailError } from '../../src/modules/notifications/classifyMailError.js';
import { buildEmail } from '../../src/modules/notifications/emailTemplates.js';

const err = (props) => Object.assign(new Error('raw text with bob@secret.example'), props);

describe('classifyMailError', () => {
  it.each([
    ['rejected recipient', { code: 'EENVELOPE' }, true],
    ['550 mailbox unavailable', { responseCode: 550 }, true],
    ['554 transaction failed', { responseCode: 554 }, true],
    ['451 try later', { responseCode: 451 }, false],
    ['connection refused', { code: 'ECONNECTION' }, false],
    ['timeout', { code: 'ETIMEDOUT' }, false],
    ['auth failure', { code: 'EAUTH' }, false],
    ['unknown error', {}, false],
  ])('%s -> permanent=%s', (_n, props, permanent) => {
    expect(classifyMailError(err(props)).permanent).toBe(permanent);
  });

  it('never puts raw error text in the message', () => {
    for (const props of [{ code: 'EENVELOPE' }, { responseCode: 550 }, { code: 'ETIMEDOUT' }, {}]) {
      expect(classifyMailError(err(props)).message).not.toMatch(/bob|secret|raw text/);
    }
  });

  it('handles non-Error throwables', () => {
    for (const v of [undefined, null, 'x', 42]) expect(classifyMailError(v).permanent).toBe(false);
  });
});

describe('buildEmail', () => {
  const base = {
    eventType: 'incident_opened',
    monitorName: 'Prod API',
    url: 'https://api.example.com/secret/path?token=abc123',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    failureType: 'timeout',
    failureReason: 'Request timed out',
  };

  it('shows the host and reason but never the path or query', () => {
    const { subject, text } = buildEmail(base);
    expect(subject).toBe('[PulseCheck] DOWN: Prod API');
    expect(text).toContain('api.example.com');
    expect(text).toContain('Request timed out');
    expect(text).not.toMatch(/secret|token|abc123/);
  });

  it('cannot inject headers through the monitor name', () => {
    const { subject } = buildEmail({ ...base, monitorName: 'x\r\nBcc: evil@example.com' });
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('builds a recovery email with a duration', () => {
    const { subject, text } = buildEmail({
      ...base, eventType: 'incident_resolved', resolvedAt: new Date('2026-01-01T00:10:00Z'),
    });
    expect(subject).toBe('[PulseCheck] RECOVERED: Prod API');
    expect(text).toContain('about 10 minute(s)');
  });
});