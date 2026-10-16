import { Agent, request } from 'undici';
import { performance } from 'node:perf_hooks';
import {
  parseTarget,
  resolvePublicAddresses,
  defaultPolicy,
  BlockedTargetError,
} from './ssrf/targetPolicy.js';

/** Our overall deadline (or an undici-level timeout) was hit. */
export class RequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

const UNDICI_TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** Libraries sometimes wrap the original error as `cause`. Walk the chain. */
export function findInChain(err, predicate) {
  const seen = new Set();
  for (let e = err; e && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (predicate(e)) return e;
  }
  return null;
}

/**
 * The lookup function the socket uses to resolve hostnames. It validates EVERY
 * address and returns only validated ones, so the socket connects to an IP we
 * checked. There is no second resolution an attacker could change.
 */
export function createGuardedLookup({ lookup, policy }) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    resolvePublicAddresses(hostname, lookup, policy).then(
      (addresses) => {
        const wanted =
          options?.family === 4 || options?.family === 6
            ? addresses.filter((a) => a.family === options.family)
            : addresses;
        if (wanted.length === 0) {
          return callback(new BlockedTargetError('no_addresses', 'No usable address'));
        }
        if (options?.all) {
          callback(null, wanted.map(({ address, family }) => ({ address, family })));
        } else {
          callback(null, wanted[0].address, wanted[0].family);
        }
      },
      (err) => callback(err),
    );
  };
}

/**
 * Sends one GET and returns { statusCode, latencyMs }.
 * latencyMs = time from start (DNS + connect + TLS included) to response headers.
 * Any HTTP status is a normal return value; only transport problems throw.
 * The body is never downloaded and redirects are never followed.
 */
export async function safeRequest(urlString, { timeoutMs, lookup, policy = defaultPolicy } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer');
  }

  const target = parseTarget(urlString, policy); // throws BlockedTargetError (also covers IP literals)

  const agent = new Agent({
    connect: { lookup: createGuardedLookup({ lookup, policy }), timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    maxHeaderSize: 16 * 1024,
    pipelining: 0,
  });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const started = performance.now();
  try {
    const res = await request(target.url, {
      method: 'GET',
      dispatcher: agent,
      signal: controller.signal,
      headers: { 'user-agent': 'PulseCheck/1.0', accept: '*/*' },
    });
    const latencyMs = Math.round(performance.now() - started);

    res.body.on('error', () => {}); // destroying a stream can emit; nobody is listening
    res.body.destroy(); // never download the body

    return { statusCode: res.statusCode, latencyMs };
  } catch (err) {
    if (timedOut || findInChain(err, (e) => UNDICI_TIMEOUT_CODES.has(e.code))) {
      throw new RequestTimeoutError(timeoutMs);
    }
    throw err; // Day 4 classifies everything else
  } finally {
    clearTimeout(timer);
    agent.destroy().catch(() => {});
  }
}