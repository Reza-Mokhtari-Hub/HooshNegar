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

export async function testTelegramBotConnection(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramBotTestResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const meRes = await fetchImpl(`https://api.telegram.org/bot${botToken}/getMe`, {
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
        message: `خطای Telegram API: ${redactSecrets(meJson.description ?? `HTTP ${meRes.status}`, [botToken])}`,
      };
    }

    let webhookInfo: TelegramBotTestResult['webhookInfo'];
    try {
      const whRes = await fetchImpl(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
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
            ? redactSecrets(whJson.result.last_error_message, [botToken])
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
      message: `عدم دسترسی به Telegram API: ${redactSecrets(msg, [botToken])}`,
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
  if (!webhookUrl || !webhookUrl.startsWith('https://')) {
    return { ok: false, message: 'برای ثبت وب‌هوک، آدرس HTTPS معتبر الزامی است.' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const payload: Record<string, unknown> = {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
    };
    if (webhookSecret && webhookSecret.trim().length > 0) {
      payload.secret_token = webhookSecret.trim();
    }
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/setWebhook`, {
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
          botToken,
          webhookSecret ?? '',
        ]),
      };
    }
    return { ok: true, message: 'وب‌هوک تلگرام با موفقیت ثبت و همگام‌سازی شد.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'خطا در ثبت وب‌هوک';
    return {
      ok: false,
      message: redactSecrets(msg, [botToken, webhookSecret ?? '']),
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
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
        message: redactSecrets(json.description ?? `HTTP ${res.status}`, [botToken]),
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
        ? redactSecrets(info.last_error_message, [botToken])
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
      message: redactSecrets(msg, [botToken]),
    };
  } finally {
    clearTimeout(timeout);
  }
}

