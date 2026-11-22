/**
 * Cloudflare Workers shim for `iconv-lite` (aliased in wrangler.jsonc).
 *
 * Legacy iconv-lite@0.4.x (used by Express body-parser -> raw-body) declares
 * `"browser": { "./lib/streams.js": false }` in package.json while checking
 * `process.versions.node` at runtime, causing `require("./streams")(iconv)` to
 * throw `TypeError: require_streams(...) is not a function` under workerd + nodejs_compat.
 *
 * This shim implements the exact iconv-lite API used by raw-body / body-parser
 * on top of Cloudflare Workers' native TextDecoder / TextEncoder.
 */

const ENCODING_ALIASES: Record<string, string> = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  ascii: 'utf-8',
  usascii: 'utf-8',
  latin1: 'iso-8859-1',
  binary: 'iso-8859-1',
  iso88591: 'iso-8859-1',
  'iso-8859-1': 'iso-8859-1',
  windows1252: 'windows-1252',
  'windows-1252': 'windows-1252',
  utf16le: 'utf-16le',
  'utf-16le': 'utf-16le',
  ucs2: 'utf-16le',
  'ucs-2': 'utf-16le',
  utf16be: 'utf-16be',
  'utf-16be': 'utf-16be',
};

function normalizeEncoding(encoding: string): string {
  const key = String(encoding || 'utf-8')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return ENCODING_ALIASES[key] ?? encoding.trim().toLowerCase();
}

export function encodingExists(encoding: string): boolean {
  try {
    new TextDecoder(normalizeEncoding(encoding));
    return true;
  } catch {
    return false;
  }
}

export function decode(buf: Uint8Array | Buffer | string, encoding = 'utf-8'): string {
  if (typeof buf === 'string') return buf;
  const decoder = new TextDecoder(normalizeEncoding(encoding));
  return decoder.decode(buf);
}

export function encode(str: string, encoding = 'utf-8'): Buffer {
  const norm = normalizeEncoding(encoding);
  if (norm === 'utf-8') {
    return Buffer.from(new TextEncoder().encode(str));
  }
  return Buffer.from(str, 'utf8');
}

export function getDecoder(encoding = 'utf-8') {
  const decoder = new TextDecoder(normalizeEncoding(encoding));
  return {
    write(buf: Uint8Array | Buffer): string {
      return decoder.decode(buf, { stream: true });
    },
    end(): string {
      return decoder.decode();
    },
  };
}

export function getEncoder(encoding = 'utf-8') {
  return {
    write(str: string): Buffer {
      return encode(str, encoding);
    },
    end(): Buffer | undefined {
      return undefined;
    },
  };
}

const iconv = {
  encodingExists,
  decode,
  encode,
  getDecoder,
  getEncoder,
};

export default iconv;
