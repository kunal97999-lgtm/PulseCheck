import { BlockList, isIP } from 'node:net';

// Every range here is a place a public-internet health check has no business going.
const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // "this network" (0.0.0.0 often means localhost when connecting)
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, INCLUDES cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation
  ['192.88.99.0', 24],   // deprecated 6to4 relay
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation
  ['203.0.113.0', 24],   // documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, includes 255.255.255.255 broadcast
];

const BLOCKED_V6 = [
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['::ffff:0:0', 96],    // IPv4-mapped (embeds an IPv4 address)
  ['64:ff9b::', 96],     // NAT64 (embeds an IPv4 address)
  ['64:ff9b:1::', 48],   // local-use NAT64
  ['100::', 64],         // discard-only
  ['2001::', 32],        // Teredo tunneling
  ['2001:db8::', 32],    // documentation
  ['2002::', 16],        // 6to4 (embeds an IPv4 address)
  ['fc00::', 7],         // unique local (private), includes AWS IPv6 metadata fd00:ec2::254
  ['fe80::', 10],        // link-local
  ['fec0::', 10],        // deprecated site-local
  ['ff00::', 8],         // multicast
];

// Two lists on purpose: Node matches an IPv4 address against IPv6 rules as its
// IPv4-mapped form, so a ::ffff:0:0/96 rule in a shared list blocks ALL of IPv4.
const v4List = new BlockList();
for (const [net, prefix] of BLOCKED_V4) v4List.addSubnet(net, prefix, 'ipv4');

const v6List = new BlockList();
for (const [net, prefix] of BLOCKED_V6) v6List.addSubnet(net, prefix, 'ipv6');

/** True if connecting to this IP is forbidden. Anything unparseable is forbidden (fail closed). */
export function isBlockedIp(ip) {
  if (typeof ip !== 'string' || ip.includes('%')) return true; // zone ids like fe80::1%eth0
  const family = isIP(ip);
  if (family === 4) return v4List.check(ip, 'ipv4');
  if (family === 6) return v6List.check(ip, 'ipv6');
  return true;
}