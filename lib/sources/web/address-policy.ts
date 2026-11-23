// Which network addresses the web fetcher may connect to (SSRF protection).
//
// Impartly fetches URLs that users type in, from a server. Without this check a user
// could point it at the server's own network: loopback, the private LAN, link-local
// addresses including the cloud metadata service (169.254.169.254), and so on. So every
// address a host name resolves to must be a public unicast address, checked AFTER DNS
// resolution, and the connection is then made to that same checked address (see
// safe-fetch.ts), so a second DNS answer cannot swap in a private one (DNS rebinding).
//
// Blocked: every special-purpose range in the IANA IPv4 and IPv6 special-purpose address
// registries that is not globally reachable, plus multicast and reserved space. IPv6
// forms that embed an IPv4 address (IPv4-mapped, IPv4-compatible, NAT64 64:ff9b::/96,
// 6to4 2002::/16, Teredo 2001::/32) are refused outright, because the IPv4 address they
// carry could be anything.

import { isIP } from "node:net";

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112 direct delegation
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and 255.255.255.255 broadcast
];

function v4ToInt(address: string): number {
  const parts = address.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inV4(address: string, [base, bits]: [string, number]): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(address) & mask) === (v4ToInt(base) & mask);
}

/** Expands an IPv6 address to 8 groups of 16 bits. Returns null if it is not valid. */
export function parseIPv6(address: string): number[] | null {
  let a = address.toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  if (isIP(a) !== 6) return null;
  // A trailing dotted IPv4 part becomes two groups.
  const v4 = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    a = a.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = a.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array(fill).fill("0"), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function v6Blocked(g: number[]): boolean {
  const first = g[0];
  // :: (unspecified), ::1 (loopback), and every ::/96 form (IPv4-compatible, deprecated)
  // and ::ffff:0:0/96 (IPv4-mapped): all have the first five groups zero.
  if (g.slice(0, 5).every((x) => x === 0)) return true;
  if (first === 0x0064 && g[1] === 0xff9b) return true; // 64:ff9b::/96 and 64:ff9b:1::/48 NAT64
  if (first === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  if (first === 0x2001 && g[1] < 0x0200) return true; // 2001::/23 IETF protocol assignments (incl. Teredo 2001::/32)
  if (first === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (first === 0x2002) return true; // 6to4
  if (first === 0x3fff && g[1] < 0x1000) return true; // 3fff::/20 documentation
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // Only global unicast (2000::/3) is allowed at all.
  return (first & 0xe000) !== 0x2000;
}

/** True only for a public unicast IPv4 or IPv6 address. Anything unparseable is false. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address.split("%")[0]);
  if (kind === 4) return !V4_BLOCKED.some((range) => inV4(address, range));
  if (kind === 6) {
    const groups = parseIPv6(address);
    return groups !== null && !v6Blocked(groups);
  }
  return false;
}

/** Host names refused before any DNS lookup (defense in depth; DNS is checked anyway). */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa") || h.endsWith(".lan")) return true;
  if (h === "metadata" || h === "metadata.google.internal") return true;
  // A bare name with no dot would be resolved through the server's search domains.
  if (!h.includes(".") && !h.startsWith("[") && isIP(h) === 0) return true;
  return false;
}
