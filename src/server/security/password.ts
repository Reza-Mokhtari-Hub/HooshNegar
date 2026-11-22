import crypto from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { isCloudflareWorker } from '../config/env.ts';

const ARGON2_MEMORY_KB = 65536; // 64 MiB (OWASP recommended baseline)
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 1;
const ARGON2_HASH_LENGTH = 32;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export function hashPasswordScrypt(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(
          `$scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${derivedKey.toString('base64')}`,
        );
      },
    );
  });
}

function verifyPasswordScrypt(password: string, encodedHash: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parts = encodedHash.split('$');
    // ['', 'scrypt', 'N=...,r=...,p=...', saltB64, hashB64]
    const [, scheme, paramStr, saltB64, hashB64] = parts;
    if (parts.length !== 5 || scheme !== 'scrypt' || !paramStr || !saltB64 || !hashB64) {
      resolve(false);
      return;
    }
    const paramPairs = Object.fromEntries(
      paramStr.split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return [k ?? '', Number(v)];
      }),
    );
    const N = paramPairs.N || SCRYPT_N;
    const r = paramPairs.r || SCRYPT_R;
    const p = paramPairs.p || SCRYPT_P;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length < 8 || expected.length < 16) {
      resolve(false);
      return;
    }
    crypto.scrypt(password, salt, expected.length, { N, r, p }, (err, derivedKey) => {
      if (err || derivedKey.length !== expected.length) {
        resolve(false);
        return;
      }
      resolve(crypto.timingSafeEqual(derivedKey, expected));
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }
  if (isCloudflareWorker()) {
    return hashPasswordScrypt(password);
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
  if (!password || !encodedHash) {
    return false;
  }
  if (encodedHash.startsWith('$scrypt$')) {
    return verifyPasswordScrypt(password, encodedHash);
  }
  if (!encodedHash.startsWith('$argon2id$') || isCloudflareWorker()) {
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
