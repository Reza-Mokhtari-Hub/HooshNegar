import { describe, expect, it } from 'vitest';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  timingSafeEqualStr,
  verifyPassword,
} from './password.ts';
import { InProcessRateLimiter } from './rateLimit.ts';

describe('Argon2id Password Hashing & Session Security', () => {
  it('hashes with PHC Argon2id format and verifies passwords accurately', async () => {
    const hash = await hashPassword('StrongAdminPass2026!');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword('StrongAdminPass2026!', hash)).toBe(true);
    expect(await verifyPassword('WrongPassword2026!', hash)).toBe(false);
    expect(await verifyPassword('StrongAdminPass2026!', 'not-a-hash')).toBe(false);
  });

  it('generates unique session tokens and hashes deterministically', () => {
    const s1 = generateSessionToken();
    const s2 = generateSessionToken();
    expect(s1.rawToken).not.toBe(s2.rawToken);
    expect(s1.tokenHash).toBe(hashSessionToken(s1.rawToken));
    expect(timingSafeEqualStr(s1.csrfToken, s1.csrfToken)).toBe(true);
    expect(timingSafeEqualStr(s1.csrfToken, s2.csrfToken)).toBe(false);
  });

  it('enforces brute-force login rate limiting and lockout window', () => {
    const limiter = new InProcessRateLimiter({
      maxAttempts: 3,
      windowMs: 60_000,
      lockoutMs: 120_000,
    });
    const t0 = 1_000_000;
    expect(limiter.consume('ip:admin@test.com', t0).allowed).toBe(true);
    expect(limiter.consume('ip:admin@test.com', t0 + 100).allowed).toBe(true);
    expect(limiter.consume('ip:admin@test.com', t0 + 200).allowed).toBe(true);
    const blocked = limiter.consume('ip:admin@test.com', t0 + 300);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    // Still locked during lockout window
    expect(limiter.check('ip:admin@test.com', t0 + 60_000).allowed).toBe(false);
    // Unlocked after lockout expires
    expect(limiter.check('ip:admin@test.com', t0 + 130_000).allowed).toBe(true);
  });
});
