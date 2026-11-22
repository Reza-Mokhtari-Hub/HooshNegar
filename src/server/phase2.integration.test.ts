import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.ts';
import {
  aiModels,
  aiProviders,
  aiRequests,
  creditWallets,
  modelCapabilities,
  providerCredentials,
  referralCodes,
  subscriptionPlans,
  telegramBotSettings,
  webhookEvents,
} from '../db/schema.ts';
import { createApiApp } from './app.ts';
import { ensurePlatformReady } from './services/bootstrap.ts';
import { encryptSecret, maskSecret } from './security/crypto.ts';
import {
  ensureTelegramUser,
  getAvailableModelsForUser,
} from './telegram/userService.ts';
import {
  reconcileRequestSuccess,
  refundFailedRequest,
  reserveCreditsAndCreateRequest,
  UsageGuardError,
} from './services/usageService.ts';
import {
  executeQueuedGenerationJob,
  executeVideoPollJob,
} from './telegram/jobRunner.ts';
import {
  generateImageWithRoute,
  loadModelExecutionRoute,
} from './providers/engine.ts';

let server: http.Server;
let baseUrl = '';
const WEBHOOK_SECRET = 'tg_super_secret_token_phase2_test_9911';

async function httpJson(
  path: string,
  options?: { method?: string; headers?: Record<string, string>; body?: unknown },
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options?.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-json
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  process.env.AI_MOCK_MODE = 'true';
  process.env.ENCRYPTION_MASTER_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.QSTASH_TOKEN = 'test_qstash_token';
  process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current_test_key_123456';
  process.env.QSTASH_NEXT_SIGNING_KEY = 'sig_next_test_key_123456';
  process.env.QSTASH_CALLBACK_BASE_URL = 'http://127.0.0.1:3000';

  await ensurePlatformReady();

  // Configure encrypted Telegram webhook secret in DB
  const db = getDb();
  const encSecret = encryptSecret(WEBHOOK_SECRET);
  await db
    .update(telegramBotSettings)
    .set({
      encryptedWebhookSecret: encSecret.ciphertext,
      webhookSecretIv: encSecret.iv,
      webhookSecretAuthTag: encSecret.authTag,
      maskedWebhookSecret: maskSecret(WEBHOOK_SECRET),
      isActive: false, // Keep inactive so background update runner won't hit external Telegram API
    })
    .where(eq(telegramBotSettings.singletonKey, 'primary'));

  const app = createApiApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('Phase 2 Integration — Webhook Security, Users, Dynamic Models, Credits & Jobs', () => {
  it('enforces Telegram webhook secret-token header and rejects missing/wrong secrets with 401', async () => {
    const missing = await httpJson('/api/telegram/webhook', {
      method: 'POST',
      body: { update_id: 1001, message: { text: '/start' } },
    });
    expect(missing.status).toBe(401);

    const wrong = await httpJson('/api/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret' },
      body: { update_id: 1001, message: { text: '/start' } },
    });
    expect(wrong.status).toBe(401);

    const valid = await httpJson('/api/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
      body: { update_id: 202601, message: { text: '/start' } },
    });
    expect(valid.status).toBe(200);
    expect(valid.json.ok).toBe(true);
    expect(valid.json.queued).toBe(true);
  });

  it('handles duplicate Telegram update_id idempotently without double-inserting events', async () => {
    const dup = await httpJson('/api/telegram/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
      body: { update_id: 202601, message: { text: '/start' } },
    });
    expect(dup.status).toBe(200);
    expect(dup.json.ok).toBe(true);
    expect(dup.json.duplicate).toBe(true);

    const db = getDb();
    const rows = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.idempotencyKey, 'tg_update:202601'));
    expect(rows.length).toBe(1);
  });

  it('rejects unsigned QStash background job worker requests with 401', async () => {
    const proc = await httpJson('/api/jobs/process', {
      method: 'POST',
      body: { kind: 'ai_generation_job', idempotencyKey: 'x', jobId: 'fake' },
    });
    expect(proc.status).toBe(401);

    const poll = await httpJson('/api/jobs/poll', {
      method: 'POST',
      body: { kind: 'video_poll_job', idempotencyKey: 'x', jobId: 'fake' },
    });
    expect(poll.status).toBe(401);

    const fail = await httpJson('/api/jobs/failed', {
      method: 'POST',
      body: { requestId: 'fake' },
    });
    expect(fail.status).toBe(401);
  });

  it('blocks unauthorized admin API access to all Phase 2 monitor & Telegram admin routes', async () => {
    const protectedEndpoints = [
      '/api/telegram/webhook-status',
      '/api/monitor/bot',
      '/api/monitor/connected-users',
      '/api/monitor/conversations',
      '/api/monitor/requests',
      '/api/monitor/jobs',
      '/api/monitor/provider-performance',
      '/api/monitor/model-usage',
      '/api/monitor/failed-requests',
    ];

    for (const ep of protectedEndpoints) {
      const res = await httpJson(ep);
      expect(res.status, `Expected 401 on ${ep}`).toBe(401);
    }
  });

  it('creates Telegram user with default Free plan, wallet, and referral attribution', async () => {
    const db = getDb();
    await db.insert(referralCodes).values({
      code: 'LAUNCH2026',
      rewardCredits: 30,
      isActive: true,
    });

    const ensured = await ensureTelegramUser({
      telegramUserId: 991001,
      telegramChatId: 991001,
      username: 'sara_ai',
      firstName: 'سارا',
      lastName: 'احمدی',
      languageCode: 'fa',
      referralCode: 'REF_LAUNCH2026',
    });

    expect(ensured.isNewUser).toBe(true);
    expect(ensured.referralApplied).toBe(true);
    expect(ensured.plan?.tier).toBe('free');
    // Default free plan grants 50 + 30 referral bonus = 80
    expect(ensured.walletBalance).toBe(80);

    // Calling again updates existing user idempotently
    const second = await ensureTelegramUser({
      telegramUserId: 991001,
      telegramChatId: 991001,
      username: 'sara_ai',
      firstName: 'سارا',
    });
    expect(second.isNewUser).toBe(false);
    expect(second.user.id).toBe(ensured.user.id);
  });

  it('supports dynamic DB-driven model selection, atomic credit reservation, refunds on failure, and async video polling', async () => {
    const db = getDb();
    const encKey = encryptSecret('sk-test-valid-mock-key-123456');

    const [provider] = await db
      .insert(aiProviders)
      .values({
        name: 'Gemini Primary Test',
        slug: 'gemini-primary-test',
        providerType: 'google_gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        isActive: true,
        priority: 1,
      })
      .returning();

    await db.insert(providerCredentials).values({
      providerId: provider!.id,
      label: 'primary',
      encryptedApiKey: encKey.ciphertext,
      iv: encKey.iv,
      authTag: encKey.authTag,
      keyVersion: 1,
      maskedPreview: maskSecret('sk-test-valid-mock-key-123456'),
      isActive: true,
    });

    // Active chat + video model
    const [chatModel] = await db
      .insert(aiModels)
      .values({
        providerId: provider!.id,
        name: 'Gemini 2.5 Flash',
        modelIdentifier: 'gemini-2.5-flash',
        category: 'llm',
        creditCost: '10',
        isDefault: true,
        isActive: true,
      })
      .returning();

    await db.insert(modelCapabilities).values([
      { modelId: chatModel!.id, capability: 'chat' },
      { modelId: chatModel!.id, capability: 'text_generation' },
    ]);

    const [videoModel] = await db
      .insert(aiModels)
      .values({
        providerId: provider!.id,
        name: 'Veo 3.1',
        modelIdentifier: 'veo-3.1-fast-generate-preview',
        category: 'video',
        creditCost: '15',
        isActive: true,
      })
      .returning();

    await db.insert(modelCapabilities).values([
      { modelId: videoModel!.id, capability: 'video_generation' },
    ]);

    // Inactive model (must NOT appear in dynamic user list)
    const [disabledModel] = await db
      .insert(aiModels)
      .values({
        providerId: provider!.id,
        name: 'Disabled Model',
        modelIdentifier: 'disabled-1',
        category: 'llm',
        creditCost: '5',
        isActive: false,
      })
      .returning();

    await db.insert(modelCapabilities).values([
      { modelId: disabledModel!.id, capability: 'chat' },
    ]);

    // Enable video quota on free plan for test
    await db
      .update(subscriptionPlans)
      .set({ videoGenerationLimit: 5 })
      .where(eq(subscriptionPlans.slug, 'free-default'));

    const user = await ensureTelegramUser({
      telegramUserId: 992002,
      telegramChatId: 992002,
      username: 'ali_dev',
      firstName: 'علی',
    });

    // Dynamic DB model list excludes disabled model
    const chatModels = await getAvailableModelsForUser({
      userId: user.user.id,
      capability: 'chat',
    });
    expect(chatModels.map((m) => m.id)).toContain(chatModel!.id);
    expect(chatModels.map((m) => m.id)).not.toContain(disabledModel!.id);

    // Enforce capability guard when invoking wrong capability on model route
    const chatRoute = await loadModelExecutionRoute(chatModel!.id);
    await expect(
      generateImageWithRoute(chatRoute, { prompt: 'draw a cat' }),
    ).rejects.toThrow();

    // 1) Atomic reservation + execution + success credit debit
    const reserved1 = await reserveCreditsAndCreateRequest({
      userId: user.user.id,
      modelId: chatModel!.id,
      capability: 'chat',
      idempotencyKey: 'test-req-chat-1',
      promptPreview: 'سلام دنیا',
      jobPayload: { prompt: 'سلام دنیا', silentDelivery: true },
    });

    const exec1 = await executeQueuedGenerationJob(reserved1.jobId);
    expect(exec1.ok).toBe(true);
    expect(exec1.status).toBe('succeeded');

    const [walletAfterSuccess] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, user.user.id));
    expect(Number(walletAfterSuccess!.balance)).toBe(40); // 50 - 10
    expect(Number(walletAfterSuccess!.reservedBalance)).toBe(0);

    // 2) Failed generation guarantees automatic full refund (0 charged)
    const reservedFail = await reserveCreditsAndCreateRequest({
      userId: user.user.id,
      modelId: chatModel!.id,
      capability: 'chat',
      idempotencyKey: 'test-req-fail-1',
      promptPreview: 'failing prompt',
    });
    const [walletWhileReserved] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, user.user.id));
    expect(Number(walletWhileReserved!.reservedBalance)).toBe(10);

    await refundFailedRequest({
      requestId: reservedFail.requestId,
      jobId: reservedFail.jobId,
      errorCode: 'PROVIDER_ERROR',
      errorMessage: 'Simulated upstream 500 failure',
    });

    const [walletAfterRefund] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, user.user.id));
    expect(Number(walletAfterRefund!.balance)).toBe(40); // Unchanged!
    expect(Number(walletAfterRefund!.reservedBalance)).toBe(0);

    const [failedReqRow] = await db
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.id, reservedFail.requestId));
    expect(failedReqRow?.status).toBe('failed');
    expect(Number(failedReqRow?.creditsCharged)).toBe(0);

    // 3) Insufficient credits protection
    await db
      .update(creditWallets)
      .set({ balance: '5.0000' })
      .where(eq(creditWallets.userId, user.user.id));

    await expect(
      reserveCreditsAndCreateRequest({
        userId: user.user.id,
        modelId: chatModel!.id,
        capability: 'chat',
        idempotencyKey: 'test-req-low-bal',
      }),
    ).rejects.toThrow(UsageGuardError);

    // 4) Async Video Job Start + Poll Completion
    await db
      .update(creditWallets)
      .set({ balance: '100.0000' })
      .where(eq(creditWallets.userId, user.user.id));

    const vidReserved = await reserveCreditsAndCreateRequest({
      userId: user.user.id,
      modelId: videoModel!.id,
      capability: 'video_generation',
      idempotencyKey: 'test-req-video-1',
      promptPreview: 'Cinematic Tehran skyline at sunset',
      jobPayload: { prompt: 'Cinematic Tehran skyline at sunset', silentDelivery: true },
    });

    const vidStart = await executeQueuedGenerationJob(vidReserved.jobId);
    expect(vidStart.ok).toBe(true);
    expect(vidStart.status).toBe('running');

    // Poll #1 (mock returns running @ 60%), Poll #2 (mock returns succeeded + MP4 buffer)
    const poll1 = await executeVideoPollJob(vidReserved.jobId);
    expect(poll1.status).toBe('running');
    const poll2 = await executeVideoPollJob(vidReserved.jobId);
    expect(poll2.ok).toBe(true);
    expect(poll2.status).toBe('succeeded');
    expect(poll2.storageObjectKey).toContain('generated-videos/');

    // Reconcile is idempotent (calling again must not double debit)
    await reconcileRequestSuccess({ requestId: vidReserved.requestId, jobId: vidReserved.jobId });
    const [walletFinal] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, user.user.id));
    expect(Number(walletFinal!.balance)).toBe(85); // 100 - 15
  });
});
