import dns from 'node:dns';
import { isIP } from 'node:net';
import { isBlockedIp } from './ipPolicy.js';

// Documented port policy. new URL() reports default ports (80 for http, 443 for https) as ''.
export const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/** The production policy. Only tests ever pass a different one. */
export const defaultPolicy = Object.freeze({ isBlockedIp, allowedPorts: ALLOWED_PORTS });

/** An expected, user-caused rejection. `reason` is a stable machine-readable code. */
export class BlockedTargetError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.name = 'BlockedTargetError';
    this.reason = reason;
  }
}

/**
 * Validates the URL itself (scheme, credentials, port) and, if the host is an
 * IP literal, the IP too. Hostnames are NOT resolved here.
 */
export function parseTarget(urlString, policy = defaultPolicy) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new BlockedTargetError('invalid_url', 'Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedTargetError('scheme', 'Only http and https are allowed');
  }
  if (url.username || url.password) {
    throw new BlockedTargetError('credentials', 'URLs with credentials are not allowed');
  }
  if (!policy.allowedPorts.has(url.port)) {
    throw new BlockedTargetError('port', 'Port is not allowed');
  }

  // IPv6 literals arrive wrapped in brackets: "[::1]"
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const isIpLiteral = isIP(hostname) !== 0;
  if (isIpLiteral && policy.isBlockedIp(hostname)) {
    throw new BlockedTargetError('blocked_ip', 'Target address is not allowed');
  }

  return {
    url,
    hostname,
    isIpLiteral,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
  };
}

const defaultLookup = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolves a hostname and returns its addresses only if EVERY one is allowed.
 * DNS failures (ENOTFOUND, timeouts...) propagate unchanged; Day 4 classifies them.
 * `lookup` is injectable so tests never touch real DNS.
 */
export async function resolvePublicAddresses(
  hostname,
  lookup = defaultLookup,
  policy = defaultPolicy,
) {
  const addresses = await lookup(hostname);
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new BlockedTargetError('no_addresses', 'Hostname did not resolve to any address');
  }
  if (addresses.some((a) => policy.isBlockedIp(a.address))) {
    throw new BlockedTargetError('blocked_ip', 'Target address is not allowed');
  }
  return addresses;
}