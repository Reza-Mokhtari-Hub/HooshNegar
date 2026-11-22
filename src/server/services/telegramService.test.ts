import { describe, expect, it, vi } from 'vitest';
import {
  generateWebhookSecret,
  isValidTelegramTokenFormat,
  normalizeBotToken,
  normalizeWebhookUrl,
  syncTelegramWebhook,
  testTelegramBotConnection,
} from './telegramService.ts';
import {
  getCloudflareRequestContext,
  runWithCloudflareRequestContext,
} from '../cloudflare/requestContext.ts';
import { enqueueBackgroundJob, registerLocalJobProcessor } from '../queue/qstash.ts';

describe('telegramService', () => {
  it('normalizes bot tokens by removing whitespace, zero-width chars, and bot URL prefix', () => {
    expect(normalizeBotToken(' 123456789:AAF_test_token_1234567890abcd \u200B')).toBe(
      '123456789:AAF_test_token_1234567890abcd',
    );
    expect(normalizeBotToken('bot123456789:AAF_test_token_1234567890abcd')).toBe(
      '123456789:AAF_test_token_1234567890abcd',
    );
    expect(isValidTelegramTokenFormat('123456789:AAF_test_token_1234567890abcd')).toBe(true);
    expect(isValidTelegramTokenFormat('invalid-token')).toBe(false);
  });

  it('normalizes bare HTTPS origins and blank webhook URLs to /api/telegram/webhook', () => {
    expect(normalizeWebhookUrl('', 'https://hooshnegar.reza2015zzzx.workers.dev')).toBe(
      'https://hooshnegar.reza2015zzzx.workers.dev/api/telegram/webhook',
    );
    expect(normalizeWebhookUrl('https://hooshnegar.reza2015zzzx.workers.dev/')).toBe(
      'https://hooshnegar.reza2015zzzx.workers.dev/api/telegram/webhook',
    );
    expect(
      normalizeWebhookUrl('https://hooshnegar.reza2015zzzx.workers.dev/api/telegram/webhook'),
    ).toBe('https://hooshnegar.reza2015zzzx.workers.dev/api/telegram/webhook');
  });

  it('generates Telegram-compatible CSPRNG webhook secrets', () => {
    const secret = generateWebhookSecret();
    expect(secret.length).toBeGreaterThanOrEqual(24);
    expect(/^[A-Za-z0-9_-]+$/.test(secret)).toBe(true);
  });

  it('tests connection and redacts secrets on Telegram API error', async () => {
    const token = '987654321:AAF_secret_bot_token_1234567890';
    const failFetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: `Unauthorized for ${token}` }), {
        status: 401,
      }),
    ) as unknown as typeof fetch;

    const failRes = await testTelegramBotConnection(token, failFetch);
    expect(failRes.ok).toBe(false);
    expect(failRes.status).toBe('failed');
    expect(failRes.message).not.toContain(token);

    const okFetch = vi.fn(async (url: string | URL | Request) => {
      const s = String(url);
      if (s.endsWith('/getMe')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { id: 42, username: 'HooshNegarBot', first_name: 'HooshNegar', can_join_groups: true },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, result: { url: 'https://example.com/api/telegram/webhook', pending_update_count: 0 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const okRes = await testTelegramBotConnection(`bot${token}`, okFetch);
    expect(okRes.ok).toBe(true);
    expect(okRes.botInfo?.username).toBe('HooshNegarBot');
    expect(okRes.webhookInfo?.url).toBe('https://example.com/api/telegram/webhook');
  });

  it('syncs Telegram webhook with normalized URL and secret_token', async () => {
    const token = '123456789:AAF_sync_test_token_1234567890';
    const captured: { body?: Record<string, unknown> } = {};
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await syncTelegramWebhook(token, 'https://bot.example.com', 'my-secret-123', mockFetch);
    expect(res.ok).toBe(true);
    expect(captured.body?.url).toBe('https://bot.example.com/api/telegram/webhook');
    expect(captured.body?.secret_token).toBe('my-secret-123');
  });

  it('executes background jobs inside Cloudflare ctx.waitUntil while preserving request AsyncLocalStorage', async () => {
    const pending: Promise<unknown>[] = [];
    let observedExecutor: unknown = null;

    registerLocalJobProcessor(async () => {
      observedExecutor = getCloudflareRequestContext()?.sqlExecutor;
    });

    const fakeExecutor = {
      execSql: async () => ({ rows: [] }),
      beginTx: async () => 'tx1',
      endTx: async () => {},
    };

    const enqueued = await runWithCloudflareRequestContext(
      {
        sqlExecutor: fakeExecutor,
        waitUntil: (p) => {
          pending.push(p);
        },
      },
      () =>
        enqueueBackgroundJob({
          kind: 'telegram_update',
          idempotencyKey: 'tg_update:999',
          update: { update_id: 999 },
        }),
    );

    expect(enqueued.mode).toBe('cloudflare_waituntil');
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(observedExecutor).toBe(fakeExecutor);
  });
});
