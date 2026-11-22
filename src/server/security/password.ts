import crypto from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

const ARGON2_MEMORY_KB = 65536; // 64 MiB (OWASP recommended baseline)
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 1;
const ARGON2_HASH_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }
  const salt = crypto.randomBytes(16);
  return argon2id({
    password,
    salt,
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KB,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: 'encoded',
  });
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (!password || !encodedHash || !encodedHash.startsWith('$argon2id$')) {
    return false;
  }
  try {
    return await argon2Verify({
      password,
      hash: encodedHash,
    });
  } catch {
    return false;
  }
}

export function generateSessionToken(): { rawToken: string; tokenHash: string; csrfToken: string } {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(rawToken);
  const csrfToken = crypto.randomBytes(32).toString('hex');
  return { rawToken, tokenHash, csrfToken };
}

export function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
