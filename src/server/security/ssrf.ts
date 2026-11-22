import dns from 'node:dns/promises';
import net from 'node:net';

export class SsrfProtectionError extends Error {
  readonly code = 'SSRF_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfProtectionError';
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    num = (num << 8) | octet;
  }
  return num >>> 0;
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  const ranges: Array<[number, number]> = [
    [0x00000000, 0x00ffffff], // 0.0.0.0/8
    [0x0a000000, 0x0affffff], // 10.0.0.0/8 (RFC1918)
    [0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT / Alibaba metadata)
    [0x7f000000, 0x7fffffff], // 127.0.0.0/8 (loopback)
    [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 (link-local / AWS+GCP metadata)
    [0xac100000, 0xac1fffff], // 172.16.0.0/12 (RFC1918)
    [0xc0000000, 0xc00000ff], // 192.0.0.0/24
    [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16 (RFC1918)
    [0xc6120000, 0xc613ffff], // 198.18.0.0/15 (benchmark)
    [0xe0000000, 0xffffffff], // multicast & reserved
  ];
  return ranges.some(([start, end]) => n >= start && n <= end);
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const clean = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const version = net.isIP(clean);
  if (version === 4) {
    return isPrivateOrReservedIpv4(clean);
  }
  if (version === 6) {
    if (clean === '::1' || clean === '::' || clean === '0:0:0:0:0:0:0:1') return true;
    // IPv4-mapped IPv6 ::ffff:a.b.c.d
    const v4Mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Mapped?.[1]) {
      return isPrivateOrReservedIpv4(v4Mapped[1]);
    }
    // Unique local fc00::/7 (fc.. / fd..) or link-local fe80::/10 (fe8.. / fe9.. / fea.. / feb..)
    if (/^(fc|fd|fe8|fe9|fea|feb|ff)/i.test(clean)) return true;
    return false;
  }
  return true;
}

/**
 * Synchronous structural validation of outbound AI provider URLs.
 * Restricts destinations to HTTPS public endpoints and blocks localhost,
 * private networks, and cloud metadata endpoints.
 */
export function validatePublicHttpsUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new SsrfProtectionError('آدرس URL ارائه‌دهنده معتبر نیست.');
  }

  if (parsed.protocol !== 'https:') {
    throw new SsrfProtectionError('برای امنیت ارتباطات، آدرس ارائه‌دهنده باید با HTTPS شروع شود.');
  }

  if (parsed.username || parsed.password) {
    throw new SsrfProtectionError('قرار دادن نام کاربری یا رمز عبور در آدرس URL مجاز نیست.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    throw new SsrfProtectionError('نام میزبان (Hostname) معتبر نیست.');
  }

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new SsrfProtectionError('دسترسی به شبکه‌های محلی، localhost یا سرویس‌های متادیتای ابری مسدود است.');
  }

  if (net.isIP(hostname) !== 0 && isPrivateOrReservedIp(hostname)) {
    throw new SsrfProtectionError('آدرس IP خصوصی یا رزروشده برای ارائه‌دهنده مجاز نیست.');
  }

  return parsed;
}

/**
 * Full async SSRF validation including DNS resolution check to prevent DNS rebinding.
 */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<URL> {
  const parsed = validatePublicHttpsUrl(rawUrl);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (net.isIP(hostname) === 0) {
    try {
      const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
      if (addresses.length === 0) {
        throw new SsrfProtectionError('آدرس DNS میزبان ارائه‌دهنده قابل حل نیست.');
      }
      for (const addr of addresses) {
        if (isPrivateOrReservedIp(addr.address)) {
          throw new SsrfProtectionError('آدرس DNS ارائه‌دهنده به شبکه داخلی یا خصوصی اشاره دارد و مسدود شد.');
        }
      }
    } catch (err) {
      if (err instanceof SsrfProtectionError) throw err;
      // If DNS temporarily fails (e.g., offline test environment), rethrow clear error
      throw new SsrfProtectionError('خطا در بررسی DNS میزبان ارائه‌دهنده.');
    }
  }

  return parsed;
}
