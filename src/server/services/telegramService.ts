import crypto from 'node:crypto';
import { redactSecrets } from '../security/crypto.ts';

export interface TelegramBotTestResult {
  ok: boolean;
  status: 'connected' | 'failed';
  latencyMs: number;
  message: string;
  botInfo?: {
    id: number;
    username: string;
    firstName: string;
    canJoinGroups: boolean;
  };
  webhookInfo?: {
    url: string;
    pendingUpdateCount: number;
    lastErrorMessage?: string;
  };
}

/**
 * Cleans whitespace, invisible characters, and accidental `bot` URL prefix from BotFather tokens.
 */
export function normalizeBotToken(raw: string): string {
  const cleaned = raw.replace(/[\s\u200B-\u200D\uFEFF]/g, '').trim();
  const botPrefixMatch = /^bot(\d+:[A-Za-z0-9_-]+)$/i.exec(cleaned);
  return botPrefixMatch ? botPrefixMatch[1]! : cleaned;
}

export function isValidTelegramTokenFormat(token: string): boolean {
  return /^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token);
}

/**
 * Generates a Telegram-safe CSPRNG secret_token (`[A-Za-z0-9_-]`, max 256 chars).
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Ensures webhook URL points to `/api/telegram/webhook` when user supplies a bare HTTPS origin
 * or when auto-detecting from the active request/APP_URL origin.
 */
export function normalizeWebhookUrl(rawUrl: string, fallbackHttpsOrigin?: string | null): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    if (fallbackHttpsOrigin && fallbackHttpsOrigin.startsWith('https://')) {
      return `${fallbackHttpsOrigin.replace(/\/+$/, '')}/api/telegram/webhook`;
    }
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' && (parsed.pathname === '' || parsed.pathname === '/')) {
      parsed.pathname = '/api/telegram/webhook';
      return parsed.toString();
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Resolves the HTTPS Mini App URL (`/miniapp`) from a webhook URL or HTTPS origin.
 */
export function normalizeMiniAppUrl(originOrWebhookUrl?: string | null): string {
  const raw = originOrWebhookUrl?.trim() ?? '';
  if (!raw || !raw.startsWith('https://')) return '';
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}/miniapp`;
  } catch {
    return '';
  }
}

/**
 * Configures the persistent Telegram Chat Menu Button (`setChatMenuButton`) to launch
 * the HooshNegar Telegram Mini App alongside the bot.
 */
export async function syncTelegramChatMenuButton(
  botToken: string,
  miniAppUrl: string,
  buttonText = 'اپ هوش‌نگار',
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  const cleanToken = normalizeBotToken(botToken);
  const cleanUrl = normalizeMiniAppUrl(miniAppUrl);
  if (!cleanToken || !cleanUrl) {
    return {
      ok: false,
      message: 'برای تنظیم دکمه منوی مینی‌اپ، آدرس HTTPS معتبر الزامی است.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${cleanToken}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: {
          type: 'web_app',
          text: buttonText.slice(0, 64),
          web_app: { url: cleanUrl },
        },
      }),
      signal: controller.signal,
    });
    const json = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !json.ok) {
      return {
        ok: false,
        message: redactSecrets(json.description ?? `HTTP ${res.status}`, [cleanToken]),
      };
    }
    return {
      ok: true,
      message: `دکمه منوی مینی‌اپ روی ${cleanUrl} تنظیم شد.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'خطا در تنظیم دکمه منوی مینی‌اپ';
    return {
      ok: false,
      message: redactSecrets(msg, [cleanToken]),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatTelegramApiErrorFa(statusCode: number, description: string | undefined, botToken: string): string {
  const cleanDesc = redactSecrets(description ?? `HTTP ${statusCode}`, [botToken]);
  if (statusCode === 401 || /unauthorized/i.test(cleanDesc)) {
    return 'توکن ربات تلگرام نامعتبر است (۴۰۱). لطفاً توکن کامل دریافتی از @BotFather را بررسی کنید.';
  }
  if (statusCode === 404 || /not found/i.test(cleanDesc)) {
    return 'ساختار توکن ربات اشتباه است (۴۰۴). فرمت صحیح مانند 1234567890:AAF... می‌باشد.';
  }
  return `خطای Telegram API: ${cleanDesc}`;
}

export async function testTelegramBotConnection(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramBotTestResult> {
  const cleanToken = normalizeBotToken(botToken);
  if (!isValidTelegramTokenFormat(cleanToken)) {
    return {
      ok: false,
      status: 'failed',
      latencyMs: 0,
      message: 'فرمت توکن ربات تلگرام معتبر نیست. توکن باید شامل شناسه عددی و بخش حروفی جداشده با دو نقطه (:) باشد.',
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const meRes = await fetchImpl(`https://api.telegram.org/bot${cleanToken}/getMe`, {
      method: 'GET',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const meJson = (await meRes.json()) as {
      ok?: boolean;
      description?: string;
      result?: {
        id: number;
        username?: string;
        first_name?: string;
        can_join_groups?: boolean;
      };
    };

    if (!meRes.ok || !meJson.ok || !meJson.result) {
      return {
        ok: false,
        status: 'failed',
        latencyMs,
        message: formatTelegramApiErrorFa(meRes.status, meJson.description, cleanToken),
      };
    }

    let webhookInfo: TelegramBotTestResult['webhookInfo'];
    try {
      const whRes = await fetchImpl(`https://api.telegram.org/bot${cleanToken}/getWebhookInfo`, {
        method: 'GET',
        signal: controller.signal,
      });
      const whJson = (await whRes.json()) as {
        ok?: boolean;
        result?: { url?: string; pending_update_count?: number; last_error_message?: string };
      };
      if (whJson.ok && whJson.result) {
        webhookInfo = {
          url: whJson.result.url ?? '',
          pendingUpdateCount: whJson.result.pending_update_count ?? 0,
          lastErrorMessage: whJson.result.last_error_message
            ? redactSecrets(whJson.result.last_error_message, [cleanToken])
            : undefined,
        };
      }
    } catch {
      // Optional diagnostic check
    }

    return {
      ok: true,
      status: 'connected',
      latencyMs,
      message: `اتصال به ربات @${meJson.result.username ?? 'unknown'} با موفقیت برقرار شد.`,
      botInfo: {
        id: meJson.result.id,
        username: meJson.result.username ?? '',
        firstName: meJson.result.first_name ?? '',
        canJoinGroups: Boolean(meJson.result.can_join_groups),
      },
      webhookInfo,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : 'خطا در اتصال به سرورهای تلگرام';
    return {
      ok: false,
      status: 'failed',
      latencyMs,
      message: `عدم دسترسی به Telegram API: ${redactSecrets(msg, [cleanToken])}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncTelegramWebhook(
  botToken: string,
  webhookUrl: string,
  webhookSecret?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  const cleanToken = normalizeBotToken(botToken);
  const normalizedUrl = normalizeWebhookUrl(webhookUrl);
  if (!normalizedUrl || !normalizedUrl.startsWith('https://')) {
    return { ok: false, message: 'برای ثبت وب‌هوک، آدرس HTTPS معتبر الزامی است.' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const payload: Record<string, unknown> = {
      url: normalizedUrl,
      allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
    };
    if (webhookSecret && webhookSecret.trim().length > 0) {
      payload.secret_token = webhookSecret.trim();
    }
    const res = await fetchImpl(`https://api.telegram.org/bot${cleanToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const json = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !json.ok) {
      return {
        ok: false,
        message: redactSecrets(json.description ?? `HTTP ${res.status}`, [
          cleanToken,
          webhookSecret ?? '',
        ]),
      };
    }
    return {
      ok: true,
      message: `وب‌هوک تلگرام با موفقیت روی ${normalizedUrl} ثبت و همگام‌سازی شد.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'خطا در ثبت وب‌هوک';
    return {
      ok: false,
      message: redactSecrets(msg, [cleanToken, webhookSecret ?? '']),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface TelegramWebhookStatusResult {
  ok: boolean;
  url: string;
  hasCustomCertificate: boolean;
  pendingUpdateCount: number;
  ipAddress?: string;
  lastErrorDate?: string | null;
  lastErrorMessage?: string | null;
  maxConnections?: number;
  allowedUpdates?: string[];
  message: string;
}

export async function getTelegramWebhookStatus(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramWebhookStatusResult> {
  const cleanToken = normalizeBotToken(botToken);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${cleanToken}/getWebhookInfo`, {
      method: 'GET',
      signal: controller.signal,
    });
    const json = (await res.json()) as {
      ok?: boolean;
      description?: string;
      result?: {
        url?: string;
        has_custom_certificate?: boolean;
        pending_update_count?: number;
        ip_address?: string;
        last_error_date?: number;
        last_error_message?: string;
        max_connections?: number;
        allowed_updates?: string[];
      };
    };

    if (!res.ok || !json.ok || !json.result) {
      return {
        ok: false,
        url: '',
        hasCustomCertificate: false,
        pendingUpdateCount: 0,
        message: formatTelegramApiErrorFa(res.status, json.description, cleanToken),
      };
    }

    const info = json.result;
    return {
      ok: true,
      url: info.url ?? '',
      hasCustomCertificate: Boolean(info.has_custom_certificate),
      pendingUpdateCount: info.pending_update_count ?? 0,
      ipAddress: info.ip_address,
      lastErrorDate: info.last_error_date
        ? new Date(info.last_error_date * 1000).toISOString()
        : null,
      lastErrorMessage: info.last_error_message
        ? redactSecrets(info.last_error_message, [cleanToken])
        : null,
      maxConnections: info.max_connections,
      allowedUpdates: info.allowed_updates ?? [],
      message: info.url
        ? 'وب‌هوک تلگرام متصل و فعال است.'
        : 'هیچ آدرس وب‌هوکی در سرور تلگرام ثبت نشده است.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'خطا در استعلام وضعیت وب‌هوک';
    return {
      ok: false,
      url: '',
      hasCustomCertificate: false,
      pendingUpdateCount: 0,
      message: redactSecrets(msg, [cleanToken]),
    };
  } finally {
    clearTimeout(timeout);
  }
}
