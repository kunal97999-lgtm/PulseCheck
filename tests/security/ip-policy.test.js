import { describe, it, expect } from 'vitest';
import { isBlockedIp } from '../../src/modules/checks/ssrf/ipPolicy.js';

describe('isBlockedIp: IPv4', () => {
  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback range end', '127.255.255.255'],
    ['this-network', '0.0.0.0'],
    ['private 10/8', '10.0.0.1'],
    ['private 172.16/12 start', '172.16.0.1'],
    ['private 172.16/12 end', '172.31.255.255'],
    ['private 192.168/16', '192.168.1.1'],
    ['cloud metadata', '169.254.169.254'],
    ['link-local', '169.254.0.1'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['multicast', '224.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['documentation', '203.0.113.7'],
  ])('blocks %s (%s)', (_name, ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ['Google DNS', '8.8.8.8'],
    ['Cloudflare DNS', '1.1.1.1'],
    ['example.com', '93.184.216.34'],
    ['just below 172.16/12', '172.15.255.255'],
    ['just above 172.16/12', '172.32.0.1'],
    ['just below CGNAT', '100.63.255.255'],
    ['just above CGNAT', '100.128.0.1'],
    ['11/8 is public', '11.0.0.1'],
  ])('allows %s (%s)', (_name, ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('isBlockedIp: IPv6', () => {
  it.each([
    ['loopback', '::1'],
    ['unspecified', '::'],
    ['link-local', 'fe80::1'],
    ['unique local', 'fc00::1'],
    ['AWS IPv6 metadata', 'fd00:ec2::254'],
    ['multicast', 'ff02::1'],
    ['documentation', '2001:db8::1'],
    ['IPv4-mapped loopback (dotted)', '::ffff:127.0.0.1'],
    ['IPv4-mapped loopback (hex)', '::ffff:7f00:1'],
    ['IPv4-mapped metadata', '::ffff:169.254.169.254'],
    ['NAT64 embedding loopback', '64:ff9b::7f00:1'],
    ['6to4 embedding loopback', '2002:7f00:1::'],
  ])('blocks %s (%s)', (_name, ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ['Cloudflare DNS', '2606:4700:4700::1111'],
    ['Google DNS', '2001:4860:4860::8888'],
  ])('allows %s (%s)', (_name, ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('isBlockedIp: fails closed', () => {
  it.each([
    ['empty string', ''],
    ['hostname', 'example.com'],
    ['garbage', 'not-an-ip'],
    ['zone id', 'fe80::1%eth0'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 2130706433],
  ])('blocks %s', (_name, value) => {
    expect(isBlockedIp(value)).toBe(true);
  });
});