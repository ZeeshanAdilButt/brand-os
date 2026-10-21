import net from 'node:net';

/**
 * Which network addresses an import may talk to. The URL importer makes requests on the server's
 * behalf, so it must never reach the machine's own services, a private network or a cloud metadata
 * endpoint. Everything here is a pure function over text, so it is tested without any network.
 */

interface Cidr {
  bytes: number[];
  prefix: number;
}

function cidr(text: string): Cidr {
  const [address, length] = text.split('/') as [string, string];
  const bytes = parseIp(address);
  if (!bytes) throw new Error(`bad CIDR ${text}`);
  return { bytes, prefix: Number(length) };
}

/** Bytes of an IPv4 (4) or IPv6 (16) address, or null when the text is not an IP literal. */
export function parseIp(text: string): number[] | null {
  const literal = text.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const family = net.isIP(literal);
  if (family === 4) return literal.split('.').map(Number);
  if (family === 6) return parseIpv6(literal);
  return null;
}

function parseIpv6(text: string): number[] | null {
  let working = text.toLowerCase();
  // An embedded dotted quad (::ffff:127.0.0.1) takes the place of the last two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(working);
  if (dotted) {
    const quad = dotted[1]!.split('.').map(Number);
    if (quad.length !== 4 || quad.some((n) => n > 255)) return null;
    working = working.slice(0, -dotted[1]!.length) + ((quad[0]! << 8) | quad[1]!).toString(16) + ':' + ((quad[2]! << 8) | quad[3]!).toString(16);
  }
  const halves = working.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...tail];
  const bytes: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group || '0', 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null;
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function inRange(bytes: number[], range: Cidr): boolean {
  let bits = range.prefix;
  for (let i = 0; i < range.bytes.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((bytes[i] ?? 0) & mask) !== ((range.bytes[i] ?? 0) & mask)) return false;
    bits -= take;
  }
  return true;
}

const BLOCKED_V4 = [
  '0.0.0.0/8', // "this" network
  '10.0.0.0/8', // private
  '100.64.0.0/10', // carrier-grade NAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, including the cloud metadata address 169.254.169.254
  '172.16.0.0/12', // private
  '192.0.0.0/24', // protocol assignments
  '192.0.2.0/24', // documentation
  '192.88.99.0/24', // 6to4 relay
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // documentation
  '203.0.113.0/24', // documentation
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, and the broadcast address
].map(cidr);

const BLOCKED_V6 = [
  '::/128', // unspecified
  '::1/128', // loopback
  '64:ff9b:1::/48', // local-use NAT64
  '100::/64', // discard
  '2001::/32', // Teredo tunnelling
  '2001:db8::/32', // documentation
  '2002::/16', // 6to4 (embeds an IPv4 address; refused outright)
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'fec0::/10', // site-local (deprecated)
  'ff00::/8', // multicast
].map(cidr);

const NAT64 = cidr('64:ff9b::/96');

/** The IPv4 address hidden inside an IPv6 one (mapped, compatible or NAT64), or null. */
function embeddedV4(bytes: number[]): number[] | null {
  const leadingZeros = bytes.slice(0, 10).every((b) => b === 0);
  if (leadingZeros && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12); // ::ffff:a.b.c.d
  if (bytes.slice(0, 12).every((b) => b === 0) && bytes.slice(12).some((b) => b !== 0)) return bytes.slice(12); // ::a.b.c.d
  if (inRange(bytes, NAT64)) return bytes.slice(12); // 64:ff9b::a.b.c.d
  return null;
}

/** True when the address is one an import must not connect to. Anything unparseable counts as blocked. */
export function isBlockedAddress(address: string): boolean {
  const bytes = parseIp(address);
  if (!bytes) return true;
  if (bytes.length === 4) return BLOCKED_V4.some((range) => inRange(bytes, range));
  const inner = embeddedV4(bytes);
  if (inner) return BLOCKED_V4.some((range) => inRange(inner, range));
  return BLOCKED_V6.some((range) => inRange(bytes, range));
}

/** Host names that are local by convention, refused even before any lookup. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localdomain') ||
    host.endsWith('.home.arpa') ||
    !host.includes('.') && net.isIP(host.replace(/^\[|\]$/g, '')) === 0
  );
}
