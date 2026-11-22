import { describe, expect, it } from 'vitest';
import {
  issueMiniAppSessionToken,
  signTelegramWebAppInitDataForTests,
  verifyMiniAppSessionToken,
  verifyTelegramWebAppInitData,
} from './miniAppAuth';

const BOT_TOKEN = '1234567890:AAFtestBotTokenForUnitVerification12345';

describe('Telegram Mini App InitData & Session Token Verification', () => {
  it('verifyTelegramWebAppInitData accepts authentic signed initData', () => {
    const nowSec = 1_760_000_000;
    const initData = signTelegramWebAppInitDataForTests(
      {
        query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
        user: {
          id: 551122334,
          first_name: 'Reza',
          username: 'rezadev',
          language_code: 'fa',
          is_premium: true,
        },
        auth_date: nowSec - 60,
        start_param: 'REF_HN334ABCD',
      },
      BOT_TOKEN,
    );

    const result = verifyTelegramWebAppInitData(initData, BOT_TOKEN, {
      nowSeconds: nowSec,
      maxAgeSeconds: 3600,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.user.id).toBe(551122334);
      expect(result.data.user.username).toBe('rezadev');
      expect(result.data.startParam).toBe('REF_HN334ABCD');
    }
  });

  it('verifyTelegramWebAppInitData rejects tampered user payload or wrong bot token', () => {
    const nowSec = 1_760_000_000;
    const initData = signTelegramWebAppInitDataForTests(
      {
        user: { id: 551122334, first_name: 'Reza' },
        auth_date: nowSec - 10,
      },
      BOT_TOKEN,
    );

    const tampered = initData.replace('551122334', '999999999');
    const tamperedRes = verifyTelegramWebAppInitData(tampered, BOT_TOKEN, { nowSeconds: nowSec });
    expect(tamperedRes.ok).toBe(false);
    if (!tamperedRes.ok) {
      expect(tamperedRes.reason).toBe('SIGNATURE_MISMATCH');
    }

    const wrongTokenRes = verifyTelegramWebAppInitData(initData, '9999999:AAFwrongTokenValue123456789012345', {
      nowSeconds: nowSec,
    });
    expect(wrongTokenRes.ok).toBe(false);
    if (!wrongTokenRes.ok) {
      expect(wrongTokenRes.reason).toBe('SIGNATURE_MISMATCH');
    }
  });

  it('verifyTelegramWebAppInitData rejects expired auth_date', () => {
    const nowSec = 1_760_000_000;
    const initData = signTelegramWebAppInitDataForTests(
      {
        user: { id: 551122334, first_name: 'Reza' },
        auth_date: nowSec - 90_000,
      },
      BOT_TOKEN,
    );

    const expiredRes = verifyTelegramWebAppInitData(initData, BOT_TOKEN, {
      nowSeconds: nowSec,
      maxAgeSeconds: 86_400,
    });
    expect(expiredRes.ok).toBe(false);
    if (!expiredRes.ok) {
      expect(expiredRes.reason).toBe('INIT_DATA_EXPIRED');
    }
  });

  it('Mini App session token round-trip rejects tampering and expiration', () => {
    process.env.SESSION_SECRET = 'unit-test-secret-minimum-32-characters-long';
    const nowMs = 1_760_000_000_000;
    const token = issueMiniAppSessionToken(778899, 600, nowMs);

    const okRes = verifyMiniAppSessionToken(token, nowMs + 10_000);
    expect(okRes.ok).toBe(true);
    if (okRes.ok) {
      expect(okRes.payload.tgUserId).toBe(778899);
    }

    const expiredRes = verifyMiniAppSessionToken(token, nowMs + 601_000);
    expect(expiredRes.ok).toBe(false);

    const tampered = `${token.slice(0, -4)}AAAA`;
    const tamperedRes = verifyMiniAppSessionToken(tampered, nowMs + 10_000);
    expect(tamperedRes.ok).toBe(false);
  });
});
