import { describe, expect, it } from 'vitest';
import { SsrfProtectionError, validatePublicHttpsUrl } from './ssrf.ts';

describe('SSRF outbound URL protection', () => {
  it('allows valid public HTTPS provider URLs', () => {
    expect(validatePublicHttpsUrl('https://api.openai.com/v1').hostname).toBe('api.openai.com');
    expect(validatePublicHttpsUrl('https://generativelanguage.googleapis.com').hostname).toBe(
      'generativelanguage.googleapis.com',
    );
    expect(validatePublicHttpsUrl('https://api.anthropic.com/v1').hostname).toBe(
      'api.anthropic.com',
    );
  });

  it('blocks non-HTTPS, localhost, private RFC1918, and cloud metadata endpoints', () => {
    const blocked = [
      'http://api.openai.com/v1',
      'https://localhost/v1',
      'https://127.0.0.1:8080/v1',
      'https://10.0.0.5/api',
      'https://172.16.10.2/api',
      'https://192.168.1.1/api',
      'https://169.254.169.254/latest/meta-data/',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://[::1]/v1',
      'https://internal.local/api',
    ];

    for (const url of blocked) {
      expect(() => validatePublicHttpsUrl(url), `Expected SSRF block for ${url}`).toThrow(
        SsrfProtectionError,
      );
    }
  });
});
