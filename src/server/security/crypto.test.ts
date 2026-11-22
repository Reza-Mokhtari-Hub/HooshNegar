import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  EncryptionKeyUnavailableError,
  encryptSecret,
  maskSecret,
  redactSecrets,
  sanitizeAuditDetails,
} from './crypto.ts';

const TEST_MASTER_KEY = crypto.randomBytes(32).toString('hex');

describe('AES-256-GCM Credential Encryption & Secret Redaction', () => {
  it('encrypts and decrypts secrets cleanly with unique IVs', () => {
    const rawKey = 'sk-proj-test-99887766554433221100abcdef';
    const enc1 = encryptSecret(rawKey, TEST_MASTER_KEY);
    const enc2 = encryptSecret(rawKey, TEST_MASTER_KEY);

    expect(enc1.ciphertext).not.toBe(rawKey);
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);

    expect(decryptSecret(enc1, TEST_MASTER_KEY)).toBe(rawKey);
    expect(decryptSecret(enc2, TEST_MASTER_KEY)).toBe(rawKey);
  });

  it('rejects tampered ciphertext via GCM authentication tag', () => {
    const enc = encryptSecret('sk-live-secret-token-value', TEST_MASTER_KEY);
    const tamperedBytes = Buffer.from(enc.ciphertext, 'base64');
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff;

    expect(() =>
      decryptSecret(
        {
          ...enc,
          ciphertext: tamperedBytes.toString('base64'),
        },
        TEST_MASTER_KEY,
      ),
    ).toThrow();
  });

  it('fails safely when encryption master key is missing or wrong length', () => {
    expect(() => encryptSecret('sk-test-secret', null)).toThrow(EncryptionKeyUnavailableError);
    expect(() => encryptSecret('sk-test-secret', 'short-invalid-key')).toThrow(
      EncryptionKeyUnavailableError,
    );
  });

  it('masks secrets without leaking full values', () => {
    const masked = maskSecret('sk-proj-1234567890abcdef');
    expect(masked).toContain('••••••••');
    expect(masked.endsWith('cdef')).toBe(true);
    expect(masked).not.toContain('1234567890');
    expect(maskSecret('tiny')).toBe('••••••••');
  });

  it('redacts known secret formats and explicit keys from error logs and audit objects', () => {
    const msg =
      'Auth failed with Bearer sk-proj-12345678901234567890 and bot 123456789:AAHxyz1234567890123456789012345';
    const clean = redactSecrets(msg);
    expect(clean).not.toContain('sk-proj-12345678901234567890');
    expect(clean).not.toContain('AAHxyz1234567890123456789012345');

    const audit = sanitizeAuditDetails({
      providerName: 'OpenAI',
      apiKey: 'sk-should-never-appear',
      nested: { webhookSecret: 'top-secret' },
    });
    expect(audit.providerName).toBe('OpenAI');
    expect(audit.apiKey).toBe('[REDACTED]');
    expect((audit.nested as Record<string, unknown>).webhookSecret).toBe('[REDACTED]');
  });
});
