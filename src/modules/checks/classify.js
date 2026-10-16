import { BlockedTargetError } from './ssrf/targetPolicy.js';
import { RequestTimeoutError, findInChain } from './httpClient.js';

export const ERROR_TYPES = Object.freeze([
  'http_status', 'timeout', 'dns', 'connection', 'tls', 'blocked', 'other',
]);

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const DNS_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME',
  'ESERVFAIL', 'ENODATA', 'ETIMEOUT', 'EBADNAME', 'EBADRESP',
]);

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const CONNECTION_MESSAGES = {
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset by server',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  EPIPE: 'Connection closed unexpectedly',
  UND_ERR_SOCKET: 'Connection closed unexpectedly',
  UND_ERR_CLOSED: 'Connection closed unexpectedly',
};

const TLS_MESSAGES = {
  CERT_HAS_EXPIRED: 'TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate is self-signed',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate chain contains a self-signed certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS certificate issuer is not trusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match the hostname',
};

const code = (e) => (typeof e.code === 'string' ? e.code : null);
const firstCode = (err, predicate) => {
  const found = findInChain(err, predicate);
  return found ? code(found) : null;
};

const isTlsCode = (e) => {
  const c = code(e);
  return c !== null && (TLS_CODES.has(c) || c.startsWith('ERR_SSL') || c.startsWith('ERR_TLS'));
};
const isDns = (e) =>
  (code(e) !== null && DNS_CODES.has(code(e))) ||
  (typeof e.syscall === 'string' && (e.syscall === 'getaddrinfo' || e.syscall.startsWith('query')));

/**
 * Maps any thrown value to { errorType, message, unexpected, detail }.
 * `message` is a FIXED string safe to store and show to users.
 * `detail` is for server logs only and must never be stored or returned.
 */
export function classifyFailure(err) {
  const blocked = findInChain(err, (e) => e instanceof BlockedTargetError);
  if (blocked) {
    return {
      errorType: 'blocked',
      message: 'Target is not permitted by security policy',
      unexpected: false,
      detail: blocked.reason,
    };
  }

  const timeout =
    findInChain(err, (e) => e instanceof RequestTimeoutError) ||
    findInChain(err, (e) => code(e) !== null && TIMEOUT_CODES.has(code(e)));
  if (timeout) {
    return { errorType: 'timeout', message: 'Request timed out', unexpected: false };
  }

  if (findInChain(err, isDns)) {
    return { errorType: 'dns', message: 'DNS lookup failed', unexpected: false };
  }

  const tlsCode = firstCode(err, isTlsCode);
  if (tlsCode) {
    return {
      errorType: 'tls',
      message: TLS_MESSAGES[tlsCode] ?? 'TLS handshake failed',
      unexpected: false,
    };
  }

  const connCode = firstCode(err, (e) => code(e) !== null && code(e) in CONNECTION_MESSAGES);
  if (connCode) {
    return { errorType: 'connection', message: CONNECTION_MESSAGES[connCode], unexpected: false };
  }

  if (findInChain(err, (e) => code(e) === 'UND_ERR_HEADERS_OVERFLOW')) {
    return {
      errorType: 'other',
      message: 'Response headers exceeded the size limit',
      unexpected: false,
    };
  }

  return { errorType: 'other', message: 'Check failed unexpectedly', unexpected: true };
}

/** Applies the monitor's success criteria to an HTTP response. */
export function evaluateStatus(statusCode, { expectedStatusMin, expectedStatusMax }) {
  if (statusCode >= expectedStatusMin && statusCode <= expectedStatusMax) {
    return { success: true, errorType: null, message: null };
  }
  return {
    success: false,
    errorType: 'http_status',
    message: `Unexpected status code ${statusCode} (expected ${expectedStatusMin}-${expectedStatusMax})`,
  };
}