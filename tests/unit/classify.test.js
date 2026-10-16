import { describe, it, expect } from 'vitest';
import { classifyFailure, evaluateStatus } from '../../src/modules/checks/classify.js';
import { RequestTimeoutError } from '../../src/modules/checks/httpClient.js';
import { BlockedTargetError } from '../../src/modules/checks/ssrf/targetPolicy.js';

const withCode = (c, extra = {}) => Object.assign(new Error(`raw ${c} text`), { code: c, ...extra });
const wrapped = (inner) => new Error('fetch failed', { cause: inner });

describe('classifyFailure', () => {
  it.each([
    ['our deadline', new RequestTimeoutError(1000)],
    ['undici connect timeout', withCode('UND_ERR_CONNECT_TIMEOUT')],
    ['undici headers timeout', withCode('UND_ERR_HEADERS_TIMEOUT')],
    ['socket ETIMEDOUT', withCode('ETIMEDOUT')],
  ])('timeout: %s', (_n, err) => {
    expect(classifyFailure(err).errorType).toBe('timeout');
  });

  it.each([
    ['ENOTFOUND', withCode('ENOTFOUND', { syscall: 'getaddrinfo' })],
    ['EAI_AGAIN', withCode('EAI_AGAIN', { syscall: 'getaddrinfo' })],
    ['c-ares timeout', withCode('ETIMEOUT', { syscall: 'queryA' })],
  ])('dns: %s', (_n, err) => {
    expect(classifyFailure(err).errorType).toBe('dns');
  });

  it('classifies ECONNREFUSED from the DNS resolver as dns, not connection', () => {
    const err = withCode('ECONNREFUSED', { syscall: 'queryA' });
    expect(classifyFailure(err).errorType).toBe('dns');
  });

  it.each([
    ['refused', 'ECONNREFUSED', 'Connection refused'],
    ['reset', 'ECONNRESET', 'Connection reset by server'],
    ['unreachable', 'EHOSTUNREACH', 'Host unreachable'],
    ['undici socket', 'UND_ERR_SOCKET', 'Connection closed unexpectedly'],
  ])('connection: %s', (_n, c, message) => {
    expect(classifyFailure(withCode(c, { syscall: 'connect' }))).toMatchObject({
      errorType: 'connection',
      message,
    });
  });

  it.each([
    ['expired', 'CERT_HAS_EXPIRED', 'TLS certificate has expired'],
    ['self-signed', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS certificate is self-signed'],
    ['hostname mismatch', 'ERR_TLS_CERT_ALTNAME_INVALID', 'TLS certificate does not match the hostname'],
    ['unknown SSL error', 'ERR_SSL_WRONG_VERSION_NUMBER', 'TLS handshake failed'],
  ])('tls: %s', (_n, c, message) => {
    expect(classifyFailure(withCode(c))).toMatchObject({ errorType: 'tls', message });
  });

  it('finds the real error inside a wrapper (cause chain)', () => {
    expect(classifyFailure(wrapped(withCode('ECONNREFUSED'))).errorType).toBe('connection');
    expect(classifyFailure(wrapped(wrapped(withCode('ENOTFOUND')))).errorType).toBe('dns');
  });

  it('classifies a blocked target, even when wrapped', () => {
    const blocked = new BlockedTargetError('blocked_ip', 'resolved to 10.0.0.5');
    expect(classifyFailure(blocked).errorType).toBe('blocked');
    expect(classifyFailure(wrapped(blocked)).errorType).toBe('blocked');
  });

  it('blocked wins over everything else in the chain', () => {
    const err = new Error('x', { cause: new BlockedTargetError('blocked_ip') });
    err.code = 'ECONNREFUSED';
    expect(classifyFailure(err).errorType).toBe('blocked');
  });

  it('marks unknown errors as other + unexpected', () => {
    const c = classifyFailure(new TypeError('boom'));
    expect(c).toMatchObject({ errorType: 'other', unexpected: true });
  });

  it('handles non-Error throwables without crashing', () => {
    for (const v of [undefined, null, 'a string', 42, {}]) {
      expect(classifyFailure(v).errorType).toBe('other');
    }
  });

  it('never leaks raw error text, IPs, or hostnames into the stored message', () => {
    const nasty = [
      new BlockedTargetError('blocked_ip', 'resolved internal.corp to 10.0.0.5'),
      withCode('ECONNREFUSED', { message: 'connect ECONNREFUSED 10.0.0.5:5432', address: '10.0.0.5' }),
      withCode('ENOTFOUND', { message: 'getaddrinfo ENOTFOUND secret.internal', hostname: 'secret.internal' }),
      new Error('password=hunter2 at /srv/app/secret.js'),
    ];
    for (const err of nasty) {
      const { message } = classifyFailure(err);
      expect(message).not.toMatch(/10\.0\.0\.5|internal|secret|hunter2|\/srv|5432/);
    }
  });

  it('gives every blocked reason the same message (no oracle)', () => {
    const messages = ['blocked_ip', 'port', 'scheme', 'no_addresses'].map(
      (r) => classifyFailure(new BlockedTargetError(r)).message,
    );
    expect(new Set(messages).size).toBe(1);
  });
});

describe('evaluateStatus', () => {
  const range = { expectedStatusMin: 200, expectedStatusMax: 299 };

  it.each([200, 204, 299])('%i is success', (s) => {
    expect(evaluateStatus(s, range)).toEqual({ success: true, errorType: null, message: null });
  });

  it.each([199, 300, 302, 404, 500, 503])('%i is an http_status failure', (s) => {
    const r = evaluateStatus(s, range);
    expect(r.success).toBe(false);
    expect(r.errorType).toBe('http_status');
    expect(r.message).toContain(String(s));
  });

  it('honors custom success criteria', () => {
    expect(evaluateStatus(302, { expectedStatusMin: 200, expectedStatusMax: 399 }).success).toBe(true);
    expect(evaluateStatus(404, { expectedStatusMin: 404, expectedStatusMax: 404 }).success).toBe(true);
    expect(evaluateStatus(200, { expectedStatusMin: 404, expectedStatusMax: 404 }).success).toBe(false);
  });
});