import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { safeRequest, RequestTimeoutError, findInChain } from '../../src/modules/checks/httpClient.js';
import { BlockedTargetError } from '../../src/modules/checks/ssrf/targetPolicy.js';
import { isBlockedIp } from '../../src/modules/checks/ssrf/ipPolicy.js';

const servers = [];

async function startServer(handler) {
  const state = { connections: 0, requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, host: req.headers.host });
    handler(req, res, state);
  });
  server.on('connection', () => state.connections++);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { ...state, state, port: server.address().port };
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
});

// Test-only: allow loopback, and allow the test server's random port.
const permissive = (port) => ({
  isBlockedIp: () => false,
  allowedPorts: new Set(['', String(port)]),
});
// Test-only: REAL IP rules, but allow the test server's random port,
// so the only thing standing between us and the server is the guard.
const strictIpsWithPort = (port) => ({
  isBlockedIp,
  allowedPorts: new Set(['', String(port)]),
});

describe('safeRequest: normal behavior', () => {
  it('returns status code and latency', async () => {
    const srv = await startServer((req, res) => res.end('ok'));
    const result = await safeRequest(`http://127.0.0.1:${srv.port}/health`, {
      timeoutMs: 2000,
      policy: permissive(srv.port),
    });
    expect(result.statusCode).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs).toBeLessThan(2000);
  });

  it('returns HTTP error statuses as normal results, not exceptions', async () => {
    const srv = await startServer((req, res) => {
      res.statusCode = 503;
      res.end('down');
    });
    const result = await safeRequest(`http://127.0.0.1:${srv.port}/`, {
      timeoutMs: 2000,
      policy: permissive(srv.port),
    });
    expect(result.statusCode).toBe(503);
  });

  it('does NOT follow redirects', async () => {
    const srv = await startServer((req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `http://127.0.0.1:${srv.port}/elsewhere`);
      res.end();
    });
    const result = await safeRequest(`http://127.0.0.1:${srv.port}/start`, {
      timeoutMs: 2000,
      policy: permissive(srv.port),
    });
    expect(result.statusCode).toBe(302);
    expect(srv.state.requests.map((r) => r.url)).toEqual(['/start']);
  });
});

describe('safeRequest: hostname path (guarded lookup)', () => {
  it('connects to the address the lookup returned, keeps the Host header, resolves once', async () => {
    const srv = await startServer((req, res) => res.end('ok'));
    let lookups = 0;
    const lookup = async () => {
      lookups++;
      return [{ address: '127.0.0.1', family: 4 }];
    };

    const result = await safeRequest(`http://app.test:${srv.port}/`, {
      timeoutMs: 2000,
      lookup,
      policy: permissive(srv.port),
    });
    expect(result.statusCode).toBe(200);
    expect(lookups).toBe(1); // exactly one resolution: nothing left to rebind
    expect(srv.state.requests[0].host).toBe(`app.test:${srv.port}`);
  });
});

describe('safeRequest: SSRF blocking (the server must see ZERO connections)', () => {
  it('blocks an IP-literal target', async () => {
    const srv = await startServer((req, res) => res.end('secret'));
    await expect(
      safeRequest(`http://127.0.0.1:${srv.port}/`, {
        timeoutMs: 2000,
        policy: strictIpsWithPort(srv.port),
      }),
    ).rejects.toBeInstanceOf(BlockedTargetError);
    expect(srv.state.connections).toBe(0);
  });

  it('blocks a hostname that resolves to loopback', async () => {
    const srv = await startServer((req, res) => res.end('secret'));
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];

    const err = await safeRequest(`http://evil.test:${srv.port}/`, {
      timeoutMs: 2000,
      lookup,
      policy: strictIpsWithPort(srv.port),
    }).catch((e) => e);

    const blocked = findInChain(err, (e) => e instanceof BlockedTargetError);
    expect(blocked, `unexpected error shape: ${err?.name} ${err?.message}`).toBeTruthy();
    expect(blocked.reason).toBe('blocked_ip');
    expect(srv.state.connections).toBe(0);
  });

  it('blocks a hostname with one public and one private record', async () => {
    const srv = await startServer((req, res) => res.end('secret'));
    const lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    const err = await safeRequest(`http://mixed.test:${srv.port}/`, {
      timeoutMs: 2000,
      lookup,
      policy: strictIpsWithPort(srv.port),
    }).catch((e) => e);
    expect(findInChain(err, (e) => e instanceof BlockedTargetError)).toBeTruthy();
    expect(srv.state.connections).toBe(0);
  });

  it('blocks cloud metadata with the DEFAULT policy, without any network access', async () => {
    await expect(
      safeRequest('http://169.254.169.254/latest/meta-data/', { timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(BlockedTargetError);
  });

  it('rejects disallowed ports with the default policy', async () => {
    await expect(
      safeRequest('http://example.com:22/', { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ reason: 'port' });
  });
});

describe('safeRequest: resource limits', () => {
  it('enforces the overall deadline when the server never answers', async () => {
    const srv = await startServer(() => {}); // accepts, never responds
    const started = Date.now();
    await expect(
      safeRequest(`http://127.0.0.1:${srv.port}/`, {
        timeoutMs: 300,
        policy: permissive(srv.port),
      }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not download an endless response body', async () => {
    let closed = false;
    const srv = await startServer((req, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write('x'.repeat(65536)), 5);
      res.on('close', () => {
        clearInterval(timer);
        closed = true;
      });
    });

    const started = Date.now();
    const result = await safeRequest(`http://127.0.0.1:${srv.port}/`, {
      timeoutMs: 5000,
      policy: permissive(srv.port),
    });
    expect(result.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1500);
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
  });
});

describe('safeRequest: transport failures throw', () => {
  it('rejects on connection refused (shape inspected on Day 4)', async () => {
    const srv = await startServer((req, res) => res.end());
    const port = srv.port;
    await new Promise((resolve) => servers.pop().close(resolve)); // free the port

    const err = await safeRequest(`http://127.0.0.1:${port}/`, {
      timeoutMs: 2000,
      policy: permissive(port),
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BlockedTargetError);
    expect(err).not.toBeInstanceOf(RequestTimeoutError);
    console.log('connection-refused error shape:', err.name, err.code, err.cause?.code);
  });

  it('requires a positive integer timeout', async () => {
    await expect(safeRequest('https://example.com/', {})).rejects.toBeInstanceOf(TypeError);
  });
});