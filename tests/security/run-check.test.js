import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { runCheck } from '../../src/modules/checks/runCheck.js';
import { isBlockedIp } from '../../src/modules/checks/ssrf/ipPolicy.js';

const servers = [];
async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server.address().port;
}
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
});

const permissive = (port) => ({ isBlockedIp: () => false, allowedPorts: new Set(['', String(port)]) });
const strictIps = (port) => ({ isBlockedIp, allowedPorts: new Set(['', String(port)]) });
const monitor = (port, over = {}) => ({
  id: 'test-monitor',
  url: `http://127.0.0.1:${port}/health`,
  timeoutMs: 2000,
  expectedStatusMin: 200,
  expectedStatusMax: 299,
  ...over,
});

describe('runCheck', () => {
  it('reports success for a 200', async () => {
    const port = await startServer((req, res) => res.end('ok'));
    const r = await runCheck(monitor(port), { policy: permissive(port) });
    expect(r).toMatchObject({ success: true, statusCode: 200, errorType: null, errorMessage: null });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.checkedAt).toBeInstanceOf(Date);
  });

  it('reports a 503 as an http_status failure that keeps the code and latency', async () => {
    const port = await startServer((req, res) => {
      res.statusCode = 503;
      res.end();
    });
    const r = await runCheck(monitor(port), { policy: permissive(port) });
    expect(r).toMatchObject({ success: false, statusCode: 503, errorType: 'http_status' });
    expect(r.latencyMs).not.toBeNull();
  });

  it('treats a redirect as failure by default, success if the range allows it', async () => {
    const port = await startServer((req, res) => {
      res.statusCode = 301;
      res.setHeader('Location', 'https://example.com/');
      res.end();
    });
    const strict = await runCheck(monitor(port), { policy: permissive(port) });
    expect(strict).toMatchObject({ success: false, statusCode: 301, errorType: 'http_status' });

    const lenient = await runCheck(monitor(port, { expectedStatusMax: 399 }), {
      policy: permissive(port),
    });
    expect(lenient.success).toBe(true);
  });

  it('classifies a refused connection', async () => {
    const port = await startServer((req, res) => res.end());
    await new Promise((resolve) => servers.pop().close(resolve)); // free the port
    const r = await runCheck(monitor(port), { policy: permissive(port) });
    expect(r).toMatchObject({
      success: false,
      statusCode: null,
      errorType: 'connection',
      errorMessage: 'Connection refused',
    });
  });

  it('classifies a timeout and reports roughly the deadline as latency', async () => {
    const port = await startServer(() => {}); // never answers
    const r = await runCheck(monitor(port, { timeoutMs: 300 }), { policy: permissive(port) });
    expect(r).toMatchObject({ success: false, errorType: 'timeout', errorMessage: 'Request timed out' });
    expect(r.latencyMs).toBeGreaterThanOrEqual(250);
    expect(r.latencyMs).toBeLessThan(1500);
  });

  it('classifies a DNS failure', async () => {
    const lookup = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND nope.test'), {
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo',
      });
    };
    const r = await runCheck(monitor(8080, { url: 'http://nope.test:8080/' }), {
      lookup,
      policy: permissive(8080),
    });
    expect(r).toMatchObject({ success: false, errorType: 'dns', errorMessage: 'DNS lookup failed' });
  });

  it('classifies a blocked target with no latency and a message that leaks nothing', async () => {
    const port = await startServer((req, res) => res.end('secret'));
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    const r = await runCheck(monitor(port, { url: `http://evil.test:${port}/` }), {
      lookup,
      policy: strictIps(port),
    });
    expect(r).toMatchObject({
      success: false,
      statusCode: null,
      latencyMs: null,
      errorType: 'blocked',
      errorMessage: 'Target is not permitted by security policy',
    });
    expect(JSON.stringify(r)).not.toMatch(/127\.0\.0\.1/);
  });

  it('blocks metadata with the default policy and never throws', async () => {
    const r = await runCheck({
      url: 'http://169.254.169.254/latest/meta-data/',
      timeoutMs: 1000,
      expectedStatusMin: 200,
      expectedStatusMax: 299,
    });
    expect(r.errorType).toBe('blocked');
  });

  it('never throws, even for a bad config (reported as other)', async () => {
    const r = await runCheck({
      url: 'https://example.com/',
      timeoutMs: 0, // violates safeRequest's contract
      expectedStatusMin: 200,
      expectedStatusMax: 299,
    });
    expect(r).toMatchObject({ success: false, errorType: 'other' });
  });
});