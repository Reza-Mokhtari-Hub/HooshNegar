import crypto from 'node:crypto';
import { getEncryptionMasterKeyHex } from '../config/env.ts';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

export class EncryptionKeyUnavailableError extends Error {
  constructor(message = 'کلید اصلی رمزنگاری (ENCRYPTION_MASTER_KEY) تنظیم نشده یا نامعتبر است.') {
    super(message);
    this.name = 'EncryptionKeyUnavailableError';
  }
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function parseMasterKey(explicitKeyHex?: string | null): Buffer {
  const keyHex = explicitKeyHex === undefined ? getEncryptionMasterKeyHex() : explicitKeyHex;
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new EncryptionKeyUnavailableError();
  }
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (keyBuf.length !== 32) {
    throw new EncryptionKeyUnavailableError();
  }
  return keyBuf;
}

export function encryptSecret(plaintext: string, explicitKeyHex?: string | null): EncryptedPayload {
  if (!plaintext || plaintext.trim().length === 0) {
    throw new Error('Secret value cannot be empty.');
  }
  const key = parseMasterKey(explicitKeyHex);
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptSecret(payload: EncryptedPayload, explicitKeyHex?: string | null): string {
  const key = parseMasterKey(explicitKeyHex);
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');

  if (iv.length !== IV_LENGTH_BYTES || authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error('Malformed encrypted credential metadata.');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function maskSecret(rawSecret: string): string {
  const clean = rawSecret.trim();
  if (clean.length <= 8) {
    return '••••••••';
  }
  const prefix = clean.slice(0, Math.min(6, Math.floor(clean.length / 4)));
  const suffix = clean.slice(-4);
  return `${prefix}••••••••${suffix}`;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_\-]{12,}/g,
  /AIza[0-9A-Za-z_\-]{20,}/g,
  /r8_[0-9A-Za-z]{16,}/g,
  /\b\d{7,12}:[A-Za-z0-9_\-]{25,}\b/g,
  /(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi,
  /(Key\s+)[A-Za-z0-9._\-:]{12,}/gi,
  /(x-api-key["':\s]+)[A-Za-z0-9._\-]{8,}/gi,
];

export function redactSecrets(input: string, extraSecrets: string[] = []): string {
  let output = input;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) {
      output = output.split(secret).join('[REDACTED]');
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix?: string) => {
      if (prefix && typeof prefix === 'string' && match.startsWith(prefix)) {
        return `${prefix}[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  return output;
}

export function sanitizeAuditDetails(
  details: Record<string, unknown>,
  extraSecrets: string[] = [],
): Record<string, unknown> {
  const sensitiveKeyRegex = /(key|secret|token|password|authorization|cookie|hash)/i;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (sensitiveKeyRegex.test(k)) {
      result[k] = '[REDACTED]';
    } else if (typeof v === 'string') {
      result[k] = redactSecrets(v, extraSecrets);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = sanitizeAuditDetails(v as Record<string, unknown>, extraSecrets);
    } else {
      result[k] = v;
    }
  }
  return result;
}
