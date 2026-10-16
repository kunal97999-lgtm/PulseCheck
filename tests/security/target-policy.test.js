import { describe, it, expect } from 'vitest';
import {
  parseTarget,
  resolvePublicAddresses,
  BlockedTargetError,
} from '../../src/modules/checks/ssrf/targetPolicy.js';

const reasonOf = (fn) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BlockedTargetError);
    return err.reason;
  }
  return null; // did not throw
};

describe('parseTarget: URL rules', () => {
  it('accepts normal public URLs and reports the effective port', () => {
    expect(parseTarget('https://api.example.com/health')).toMatchObject({
      hostname: 'api.example.com',
      port: 443,
      isIpLiteral: false,
    });
    expect(parseTarget('http://example.com/').port).toBe(80);
    expect(parseTarget('https://example.com:8443/x').port).toBe(8443);
  });

  it('accepts a public IP literal', () => {
    expect(parseTarget('http://93.184.216.34/health')).toMatchObject({ isIpLiteral: true });
  });

  it.each([
    ['ftp scheme', 'ftp://example.com/', 'scheme'],
    ['file scheme', 'file:///etc/passwd', 'scheme'],
    ['javascript scheme', 'javascript:alert(1)', 'scheme'],
    ['gopher scheme', 'gopher://example.com/', 'scheme'],
    ['credentials', 'https://user:pass@example.com/', 'credentials'],
    ['username only', 'https://user@example.com/', 'credentials'],
    ['SSH port', 'https://example.com:22/', 'port'],
    ['Postgres port', 'http://example.com:5432/', 'port'],
    ['Redis port', 'http://example.com:6379/', 'port'],
    ['not a URL', 'not a url', 'invalid_url'],
  ])('rejects %s', (_name, url, reason) => {
    expect(reasonOf(() => parseTarget(url))).toBe(reason);
  });
});

describe('parseTarget: IP literals', () => {
  it.each([
    ['loopback', 'http://127.0.0.1/'],
    ['loopback with allowed port', 'http://127.0.0.1:8080/admin'],
    ['private 10/8', 'http://10.0.0.5/'],
    ['private 192.168/16', 'http://192.168.0.1/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 unique local', 'http://[fd00:ec2::254]/'],
    ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped IPv6 (hex)', 'http://[::ffff:7f00:1]/'],
  ])('blocks %s', (_name, url) => {
    expect(reasonOf(() => parseTarget(url))).toBe('blocked_ip');
  });

  // The URL parser rewrites these spellings to dotted decimal BEFORE we check.
  // These tests prove that, instead of us assuming it.
  it.each([
    ['decimal integer', 'http://2130706433/'],
    ['hex', 'http://0x7f000001/'],
    ['octal', 'http://017700000001/'],
    ['shorthand', 'http://127.1/'],
    ['mixed hex dotted', 'http://0x7f.0.0.1/'],
    ['metadata as integer', 'http://2852039166/'],
  ])('blocks obfuscated IPv4: %s', (_name, url) => {
    expect(reasonOf(() => parseTarget(url))).toBe('blocked_ip');
  });
});

describe('resolvePublicAddresses (fake DNS, no network)', () => {
  const fakeLookup = (addresses) => async () => addresses;

  it('returns the addresses when all are public', async () => {
    const addrs = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    await expect(resolvePublicAddresses('example.com', fakeLookup(addrs))).resolves.toEqual(addrs);
  });

  it('rejects a hostname that resolves to loopback (the classic bypass)', async () => {
    const lookup = fakeLookup([{ address: '127.0.0.1', family: 4 }]);
    await expect(resolvePublicAddresses('evil.example', lookup)).rejects.toMatchObject({
      reason: 'blocked_ip',
    });
  });

  it('rejects a hostname that resolves to cloud metadata', async () => {
    const lookup = fakeLookup([{ address: '169.254.169.254', family: 4 }]);
    await expect(resolvePublicAddresses('evil.example', lookup)).rejects.toMatchObject({
      reason: 'blocked_ip',
    });
  });

  it('rejects the whole host when only ONE of several records is private', async () => {
    const lookup = fakeLookup([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(resolvePublicAddresses('mixed.example', lookup)).rejects.toMatchObject({
      reason: 'blocked_ip',
    });
  });

  it('rejects an IPv4-mapped IPv6 record that hides loopback', async () => {
    const lookup = fakeLookup([{ address: '::ffff:127.0.0.1', family: 6 }]);
    await expect(resolvePublicAddresses('sneaky.example', lookup)).rejects.toMatchObject({
      reason: 'blocked_ip',
    });
  });

  it('rejects an empty answer', async () => {
    await expect(resolvePublicAddresses('empty.example', fakeLookup([]))).rejects.toMatchObject({
      reason: 'no_addresses',
    });
  });

  it('lets DNS errors propagate unchanged for later classification', async () => {
    const lookup = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND nope.example'), { code: 'ENOTFOUND' });
    };
    await expect(resolvePublicAddresses('nope.example', lookup)).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
  });
});