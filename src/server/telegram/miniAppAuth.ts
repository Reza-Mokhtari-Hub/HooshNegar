import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { telegramBotSettings } from '../../db/schema.ts';
import { getSessionSecret } from '../config/env.ts';
import { decryptSecret } from '../security/crypto.ts';
import { ensureTelegramUser, type EnsuredTelegramUser } from './userService.ts';

export interface VerifiedTelegramWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export interface VerifiedTelegramInitData {
  authDate: number;
  queryId?: string;
  startParam?: string;
  chatType?: string;
  user: VerifiedTelegramWebAppUser;
}

export interface MiniAppSessionPayload {
  tgUserId: number;
  exp: number;
  iat: number;
}

export interface MiniAppRequest extends Request {
  miniAppAuth?: {
    ensured: EnsuredTelegramUser;
    telegramUserId: number;
    startParam?: string;
    sessionToken: string;
  };
}

function timingSafeHexEqual(hexA: string, hexB: string): boolean {
  if (hexA.length !== hexB.length || hexA.length === 0) return false;
  try {
    const a = Buffer.from(hexA, 'hex');
    const b = Buffer.from(hexB, 'hex');
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Cryptographically verifies official Telegram Mini App `window.Telegram.WebApp.initData`
 * using Telegram's WebAppData HMAC-SHA256 specification:
 * secret_key = HMAC_SHA256("WebAppData", bot_token)
 * expected_hash = hex(HMAC_SHA256(secret_key, data_check_string))
 */
export function verifyTelegramWebAppInitData(
  initDataRaw: string,
  botToken: string,
  options?: {
    maxAgeSeconds?: number;
    nowSeconds?: number;
  },
): { ok: true; data: VerifiedTelegramInitData } | { ok: false; reason: string } {
  const raw = initDataRaw.trim();
  if (!raw || !botToken.trim()) {
    return { ok: false, reason: 'MISSING_INIT_DATA_OR_BOT_TOKEN' };
  }

  const params = new URLSearchParams(raw);
  const providedHash = params.get('hash')?.trim().toLowerCase() ?? '';
  if (!/^[0-9a-f]{64}$/.test(providedHash)) {
    return { ok: false, reason: 'INVALID_HASH_FORMAT' };
  }

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken.trim())
    .digest();
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (!timingSafeHexEqual(computedHash, providedHash)) {
    return { ok: false, reason: 'SIGNATURE_MISMATCH' };
  }

  const authDate = Number(params.get('auth_date') ?? '0');
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, reason: 'MISSING_AUTH_DATE' };
  }

  const maxAgeSeconds = options?.maxAgeSeconds ?? 86_400; // 24h window
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > maxAgeSeconds) {
    return { ok: false, reason: 'INIT_DATA_EXPIRED' };
  }
  if (authDate - nowSeconds > 300) {
    return { ok: false, reason: 'INIT_DATA_FUTURE_AUTH_DATE' };
  }

  const userJson = params.get('user');
  if (!userJson) {
    return { ok: false, reason: 'MISSING_USER_PAYLOAD' };
  }

  let parsedUser: VerifiedTelegramWebAppUser;
  try {
    parsedUser = JSON.parse(userJson) as VerifiedTelegramWebAppUser;
  } catch {
    return { ok: false, reason: 'INVALID_USER_JSON' };
  }

  if (!parsedUser || typeof parsedUser.id !== 'number' || !Number.isSafeInteger(parsedUser.id) || parsedUser.id <= 0) {
    return { ok: false, reason: 'INVALID_TELEGRAM_USER_ID' };
  }

  return {
    ok: true,
    data: {
      authDate,
      queryId: params.get('query_id') ?? undefined,
      startParam: params.get('start_param') ?? undefined,
      chatType: params.get('chat_type') ?? undefined,
      user: parsedUser,
    },
  };
}

/**
 * Helper used in unit & integration tests to sign valid Telegram WebApp initData strings.
 */
export function signTelegramWebAppInitDataForTests(
  fields: Record<string, string | number | Record<string, unknown>>,
  botToken: string,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'hash') continue;
    params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    pairs.push(`${k}=${v}`);
  }
  pairs.sort((a, b) => a.localeCompare(b));
  const checkStr = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(checkStr).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

/**
 * Issues a compact HMAC-SHA256 stateless Mini App bearer token bound to Telegram user ID.
 */
export function issueMiniAppSessionToken(
  telegramUserId: number,
  ttlSeconds = 60 * 60 * 12,
  nowMs = Date.now(),
): string {
  const nowSec = Math.floor(nowMs / 1000);
  const payload: MiniAppSessionPayload = {
    tgUserId: telegramUserId,
    iat: nowSec,
    exp: nowSec + ttlSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', `miniapp:${getSessionSecret()}`)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${sig}`;
}

export function verifyMiniAppSessionToken(
  token: string,
  nowMs = Date.now(),
): { ok: true; payload: MiniAppSessionPayload } | { ok: false; reason: string } {
  const parts = token.trim().split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'MALFORMED_TOKEN' };
  }
  const [encodedPayload, providedSig] = parts;
  if (!encodedPayload || !providedSig) {
    return { ok: false, reason: 'MALFORMED_TOKEN' };
  }

  const expectedSig = crypto
    .createHmac('sha256', `miniapp:${getSessionSecret()}`)
    .update(encodedPayload)
    .digest('base64url');

  const a = Buffer.from(expectedSig, 'utf8');
  const b = Buffer.from(providedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'INVALID_TOKEN_SIGNATURE' };
  }

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as MiniAppSessionPayload;
    if (
      !parsed ||
      typeof parsed.tgUserId !== 'number' ||
      !Number.isSafeInteger(parsed.tgUserId) ||
      typeof parsed.exp !== 'number'
    ) {
      return { ok: false, reason: 'INVALID_TOKEN_PAYLOAD' };
    }
    const nowSec = Math.floor(nowMs / 1000);
    if (nowSec >= parsed.exp) {
      return { ok: false, reason: 'TOKEN_EXPIRED' };
    }
    return { ok: true, payload: parsed };
  } catch {
    return { ok: false, reason: 'INVALID_TOKEN_JSON' };
  }
}

export async function loadConfiguredBotForMiniApp(): Promise<{
  botToken: string;
  botUsername: string;
  botDisplayName: string;
  supportUsername: string;
  welcomeMessage: string;
  isActive: boolean;
} | null> {
  const db = getDb();
  const [cfg] = await db
    .select()
    .from(telegramBotSettings)
    .where(eq(telegramBotSettings.singletonKey, 'primary'))
    .limit(1);

  if (!cfg?.encryptedBotToken || !cfg.tokenIv || !cfg.tokenAuthTag) {
    return null;
  }

  const botToken = decryptSecret({
    ciphertext: cfg.encryptedBotToken,
    iv: cfg.tokenIv,
    authTag: cfg.tokenAuthTag,
  });

  return {
    botToken,
    botUsername: cfg.botUsername,
    botDisplayName: cfg.botDisplayName || 'هوش‌نگار',
    supportUsername: cfg.supportUsername,
    welcomeMessage: cfg.welcomeMessage,
    isActive: cfg.isActive,
  };
}

export async function authenticateMiniAppRequest(req: MiniAppRequest): Promise<
  | {
      ok: true;
      ensured: EnsuredTelegramUser;
      telegramUserId: number;
      startParam?: string;
      sessionToken: string;
    }
  | { ok: false; status: number; code: string; error: string }
> {
  const initDataHeader =
    (typeof req.headers['x-telegram-init-data'] === 'string'
      ? req.headers['x-telegram-init-data']
      : '') ||
    (typeof req.body?.initData === 'string' ? req.body.initData : '');

  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  // Prefer fresh initData when provided so profile & referral start_param sync cleanly
  if (initDataHeader.trim()) {
    const botCfg = await loadConfiguredBotForMiniApp();
    if (!botCfg) {
      return {
        ok: false,
        status: 503,
        code: 'BOT_NOT_CONFIGURED',
        error: 'توکن ربات تلگرام در پنل مدیریت تنظیم نشده است.',
      };
    }

    const verified = verifyTelegramWebAppInitData(initDataHeader, botCfg.botToken);
    if (!verified.ok) {
      return {
        ok: false,
        status: 401,
        code: verified.reason,
        error: 'احراز هویت مینی‌اپ تلگرام نامعتبر یا منقضی است. لطفاً مینی‌اپ را مجدداً از داخل تلگرام باز کنید.',
      };
    }

    const tgUser = verified.data.user;
    const ensured = await ensureTelegramUser({
      telegramUserId: tgUser.id,
      telegramChatId: tgUser.id,
      username: tgUser.username ?? null,
      firstName: tgUser.first_name ?? null,
      lastName: tgUser.last_name ?? null,
      languageCode: tgUser.language_code ?? 'fa',
      isPremium: Boolean(tgUser.is_premium),
      referralCode: verified.data.startParam ?? null,
    });

    if (ensured.user.status !== 'active') {
      return {
        ok: false,
        status: 403,
        code: 'USER_SUSPENDED',
        error: 'حساب کاربری شما موقتاً معلق شده است.',
      };
    }

    const sessionToken = issueMiniAppSessionToken(tgUser.id);
    return {
      ok: true,
      ensured,
      telegramUserId: tgUser.id,
      startParam: verified.data.startParam,
      sessionToken,
    };
  }

  if (bearerToken) {
    const verifiedToken = verifyMiniAppSessionToken(bearerToken);
    if (!verifiedToken.ok) {
      return {
        ok: false,
        status: 401,
        code: verifiedToken.reason,
        error: 'نشست مینی‌اپ منقضی شده است. لطفاً صفحه را از داخل ربات باز کنید.',
      };
    }

    const ensured = await ensureTelegramUser({
      telegramUserId: verifiedToken.payload.tgUserId,
      telegramChatId: verifiedToken.payload.tgUserId,
    });

    if (ensured.user.status !== 'active') {
      return {
        ok: false,
        status: 403,
        code: 'USER_SUSPENDED',
        error: 'حساب کاربری شما موقتاً معلق شده است.',
      };
    }

    return {
      ok: true,
      ensured,
      telegramUserId: verifiedToken.payload.tgUserId,
      sessionToken: bearerToken,
    };
  }

  return {
    ok: false,
    status: 401,
    code: 'MINIAPP_AUTH_REQUIRED',
    error: 'برای استفاده از مینی‌اپ، لطفاً آن را از داخل ربات تلگرام باز کنید.',
  };
}

export async function requireMiniAppAuth(
  req: MiniAppRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = await authenticateMiniAppRequest(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, code: auth.code });
      return;
    }
    req.miniAppAuth = {
      ensured: auth.ensured,
      telegramUserId: auth.telegramUserId,
      startParam: auth.startParam,
      sessionToken: auth.sessionToken,
    };
    next();
  } catch (err) {
    console.error('[miniapp:auth]', err instanceof Error ? err.message : 'unknown');
    res.status(500).json({ error: 'خطا در بررسی احراز هویت مینی‌اپ.', code: 'AUTH_ERROR' });
  }
}
