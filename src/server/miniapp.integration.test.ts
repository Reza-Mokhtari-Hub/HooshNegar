import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.ts';
import {
  aiModels,
  aiProviders,
  coupons,
  creditWallets,
  modelCapabilities,
  providerCredentials,
  supportTickets,
  telegramAccounts,
  telegramBotSettings,
} from '../db/schema.ts';
import { createApiApp } from './app.ts';
import { ensurePlatformReady } from './services/bootstrap.ts';
import { reserveCreditsAndCreateRequest, refundFailedRequest } from './services/usageService.ts';
import { encryptSecret, maskSecret } from './security/crypto.ts';
import { signTelegramWebAppInitDataForTests } from './telegram/miniAppAuth.ts';

let server: http.Server;
let baseUrl = '';
const BOT_TOKEN = '987654321:AAH_miniapp_integration_test_token_xyz';

async function httpRequest(
  path: string,
  options?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<{
  status: number;
  contentType: string;
  json: Record<string, unknown>;
  buffer: Buffer | null;
}> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options?.method ?? 'GET',
    headers: {
      ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options?.headers ?? {}),
    },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, contentType, json, buffer: null };
  }
  const ab = await res.arrayBuffer();
  return { status: res.status, contentType, json: {}, buffer: Buffer.from(ab) };
}

beforeAll(async () => {
  process.env.AI_MOCK_MODE = 'true';
  process.env.ENCRYPTION_MASTER_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.SESSION_SECRET = 'miniapp_integration_test_session_secret_0123456789';

  await ensurePlatformReady();

  const db = getDb();
  const encBot = encryptSecret(BOT_TOKEN);
  await db
    .update(telegramBotSettings)
    .set({
      encryptedBotToken: encBot.ciphertext,
      tokenIv: encBot.iv,
      tokenAuthTag: encBot.authTag,
      maskedBotToken: maskSecret(BOT_TOKEN),
      botUsername: 'hooshnegar_bot',
      botDisplayName: 'هوش‌نگار',
      isActive: true,
    })
    .where(eq(telegramBotSettings.singletonKey, 'primary'));

  const encKey = encryptSecret('sk-test-miniapp-key-9999');
  const [provider] = await db
    .insert(aiProviders)
    .values({
      name: 'Gemini MiniApp Test',
      slug: 'gemini-miniapp-test',
      providerType: 'google_gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      isActive: true,
      priority: 1,
    })
    .returning();

  await db.insert(providerCredentials).values({
    providerId: provider!.id,
    label: 'miniapp-primary',
    encryptedApiKey: encKey.ciphertext,
    iv: encKey.iv,
    authTag: encKey.authTag,
    keyVersion: 1,
    maskedPreview: maskSecret('sk-test-miniapp-key-9999'),
    isActive: true,
  });

  const [chatModel] = await db
    .insert(aiModels)
    .values({
      providerId: provider!.id,
      name: 'Gemini 2.5 Flash',
      modelIdentifier: 'gemini-2.5-flash',
      category: 'llm',
      creditCost: '5',
      isDefault: true,
      isActive: true,
    })
    .returning();

  await db.insert(modelCapabilities).values([
    { modelId: chatModel!.id, capability: 'chat' },
    { modelId: chatModel!.id, capability: 'text_generation' },
  ]);

  const [imgModel] = await db
    .insert(aiModels)
    .values({
      providerId: provider!.id,
      name: 'Imagen Fast',
      modelIdentifier: 'imagen-3.0-fast-generate-001',
      category: 'image',
      creditCost: '10',
      isDefault: true,
      isActive: true,
    })
    .returning();

  await db.insert(modelCapabilities).values([
    { modelId: imgModel!.id, capability: 'image_generation' },
    { modelId: imgModel!.id, capability: 'image_editing' },
    { modelId: imgModel!.id, capability: 'image_variation' },
  ]);

  await db.insert(coupons).values({
    code: 'MINIAPP30',
    discountType: 'gift_credits',
    discountValue: '30',
    perUserLimit: 1,
    isActive: true,
  });

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

describe('Telegram Mini App End-to-End API Integration', () => {
  it('serves safe public-info without auth and rejects missing/tampered initData with 401', async () => {
    const pub = await httpRequest('/api/miniapp/public-info');
    expect(pub.status).toBe(200);
    expect(pub.json.botUsername).toBe('hooshnegar_bot');
    expect(pub.json.botReady).toBe(true);

    const noAuth = await httpRequest('/api/miniapp/bootstrap');
    expect(noAuth.status).toBe(401);

    const signed = signTelegramWebAppInitDataForTests(
      {
        auth_date: Math.floor(Date.now() / 1000),
        user: { id: 881001, first_name: 'رضا', username: 'reza_test' },
      },
      BOT_TOKEN,
    );
    const tampered = signed.replace('reza_test', 'hacker_test');
    const badAuth = await httpRequest('/api/miniapp/auth', {
      method: 'POST',
      body: { initData: tampered },
    });
    expect(badAuth.status).toBe(401);
  });

  it('authenticates Mini App user, runs chat & image generation, redeems coupon, saves preferences, and opens support ticket', async () => {
    const initData = signTelegramWebAppInitDataForTests(
      {
        auth_date: Math.floor(Date.now() / 1000),
        user: {
          id: 882002,
          first_name: 'نگار',
          username: 'negar_tg',
          language_code: 'fa',
          is_premium: true,
        },
      },
      BOT_TOKEN,
    );

    // 1) Authenticate & get bootstrap
    const authRes = await httpRequest('/api/miniapp/auth', {
      method: 'POST',
      body: { initData },
    });
    expect(authRes.status).toBe(200);
    const sessionToken = String(authRes.json.sessionToken ?? '');
    expect(sessionToken.length).toBeGreaterThan(20);
    const userObj = authRes.json.user as Record<string, unknown>;
    expect(userObj.telegramUserId).toBe(882002);
    expect(userObj.isNewUser).toBe(true);
    const initialWallet = authRes.json.wallet as { balance: number };
    expect(initialWallet.balance).toBe(50);

    const authHeaders = { Authorization: `Bearer ${sessionToken}` };

    // 2) Execute chat inside Mini App -> deducts 5 credits + stores messages
    const chatRes = await httpRequest('/api/miniapp/chat', {
      method: 'POST',
      headers: authHeaders,
      body: {
        prompt: 'سلام هوش‌نگار، حالت چطوره؟',
        conversationId: authRes.json.activeConversationId,
      },
    });
    expect(chatRes.status).toBe(200);
    expect(chatRes.json.ok).toBe(true);
    expect(String(chatRes.json.responseText ?? '').length).toBeGreaterThan(0);
    const messages = chatRes.json.messages as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(2);
    expect((chatRes.json.wallet as { balance: number }).balance).toBe(45);

    // 3) Execute image generation -> deducts 10 credits + returns owner-authorized /api/miniapp/media URL
    const genRes = await httpRequest('/api/miniapp/generate', {
      method: 'POST',
      headers: authHeaders,
      body: {
        capability: 'image_generation',
        prompt: 'یک طرح مینیمال از کوه دماوند',
        aspectRatio: '1:1',
      },
    });
    expect(genRes.status).toBe(200);
    expect(genRes.json.ok).toBe(true);
    const mediaUrl = String(genRes.json.mediaUrl ?? '');
    expect(mediaUrl).toContain('/api/miniapp/media?key=');
    expect((genRes.json.wallet as { balance: number }).balance).toBe(35);

    // Fetch protected media binary using signed token
    const mediaRes = await httpRequest(mediaUrl);
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.buffer && mediaRes.buffer.length).toBeGreaterThan(10);

    // Reject unauthenticated media fetch
    const mediaKeyOnly = mediaUrl.split('&token=')[0] ?? '';
    const unauthMedia = await httpRequest(mediaKeyOnly);
    expect(unauthMedia.status).toBe(401);

    // 4) Redeem gift coupon (+30 credits => 65)
    const couponRes = await httpRequest('/api/miniapp/coupon', {
      method: 'POST',
      headers: authHeaders,
      body: { code: 'MINIAPP30' },
    });
    expect(couponRes.status).toBe(200);
    expect(couponRes.json.creditsAwarded).toBe(30);
    expect(couponRes.json.newBalance).toBe(65);

    const db = getDb();
    const [walletRow] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, String(userObj.id)));
    expect(Number(walletRow?.balance)).toBe(65);

    // 5) Save preferences & verify persistence on telegram_accounts
    const prefRes = await httpRequest('/api/miniapp/preferences', {
      method: 'PATCH',
      headers: authHeaders,
      body: {
        systemPrompt: 'پاسخ‌های کوتاه و دقیق بنویس.',
        locale: 'fa',
      },
    });
    expect(prefRes.status).toBe(200);
    const [tgAcc] = await db
      .select()
      .from(telegramAccounts)
      .where(eq(telegramAccounts.telegramUserId, 882002));
    expect(tgAcc?.systemPrompt).toBe('پاسخ‌های کوتاه و دقیق بنویس.');

    // 6) Create support ticket
    const supportRes = await httpRequest('/api/miniapp/support', {
      method: 'POST',
      headers: authHeaders,
      body: {
        category: 'general',
        subject: 'سوال درباره مدل‌ها',
        message: 'آیا مدل جدید به زودی اضافه می‌شود؟',
      },
    });
    expect(supportRes.status).toBe(201);
    expect(supportRes.json.ok).toBe(true);
    const tickets = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.userId, String(userObj.id)));
    expect(tickets.length).toBe(1);

    // 7) Execute image_editing with clientRequestId and verify idempotent replay does not double-charge
    const editClientReqId = 'req-edit-idem-001';
    const sampleImgBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const editRes = await httpRequest('/api/miniapp/generate', {
      method: 'POST',
      headers: authHeaders,
      body: {
        capability: 'image_editing',
        prompt: 'پس‌زمینه را طلایی کن',
        sourceImageBase64: sampleImgBase64,
        sourceMimeType: 'image/png',
        aspectRatio: '1:1',
        clientRequestId: editClientReqId,
      },
    });
    expect(editRes.status).toBe(200);
    expect(editRes.json.ok).toBe(true);
    expect(String(editRes.json.mediaUrl ?? '')).toContain('/api/miniapp/media?key=');
    expect((editRes.json.wallet as { balance: number }).balance).toBe(55);

    const replayRes = await httpRequest('/api/miniapp/generate', {
      method: 'POST',
      headers: authHeaders,
      body: {
        capability: 'image_editing',
        prompt: 'پس‌زمینه را طلایی کن',
        sourceImageBase64: sampleImgBase64,
        sourceMimeType: 'image/png',
        aspectRatio: '1:1',
        clientRequestId: editClientReqId,
      },
    });
    expect(replayRes.status).toBe(200);
    expect(replayRes.json.deduplicated).toBe(true);
    expect(replayRes.json.jobId).toBe(editRes.json.jobId);
    expect((replayRes.json.wallet as { balance: number }).balance).toBe(55);

    // 8) Reserve a job, cancel it via /api/miniapp/jobs/:id/cancel -> credits refunded cleanly
    const [activeImgModel] = await db
      .select({ id: aiModels.id })
      .from(aiModels)
      .where(eq(aiModels.modelIdentifier, 'imagen-3.0-fast-generate-001'))
      .limit(1);
    const pendingReservation = await reserveCreditsAndCreateRequest({
      userId: String(userObj.id),
      modelId: activeImgModel!.id,
      capability: 'image_editing',
      idempotencyKey: `miniapp:cancel-test:${Date.now()}`,
      promptPreview: 'تست لغو پردازش',
      jobPayload: { prompt: 'cancel me', silentDelivery: true },
    });

    const cancelRes = await httpRequest(`/api/miniapp/jobs/${pendingReservation.jobId}/cancel`, {
      method: 'POST',
      headers: authHeaders,
    });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.json.ok).toBe(true);
    expect(cancelRes.json.status).toBe('canceled');
    expect((cancelRes.json.wallet as { balance: number; reservedBalance: number }).balance).toBe(55);
    expect((cancelRes.json.wallet as { balance: number; reservedBalance: number }).reservedBalance).toBe(0);

    // 9) Reserve and mark a job failed with internal multi-key trace -> GET /jobs/:id maps clean Persian error
    const failReservation = await reserveCreditsAndCreateRequest({
      userId: String(userObj.id),
      modelId: activeImgModel!.id,
      capability: 'image_editing',
      idempotencyKey: `miniapp:fail-map-test:${Date.now()}`,
      promptPreview: 'تست نمایش خطای تمیز',
      jobPayload: { prompt: 'fail me', silentDelivery: true },
    });
    await refundFailedRequest({
      requestId: failReservation.requestId,
      jobId: failReservation.jobId,
      errorCode: 'RATE_LIMITED',
      errorMessage: '#1 [HF Space · key-a · HTTP 429]: quota exhausted | #2 [HF Space · key-b · TIMEOUT]: aborted',
    });

    const jobPollRes = await httpRequest(`/api/miniapp/jobs/${failReservation.jobId}`, {
      headers: authHeaders,
    });
    expect(jobPollRes.status).toBe(200);
    const polledJob = jobPollRes.json.job as { status: string; errorCode: string; errorMessage: string };
    expect(polledJob.status).toBe('failed');
    expect(polledJob.errorCode).toBe('RATE_LIMITED');
    expect(polledJob.errorMessage).toContain('محدودیت ترافیک');
    expect(polledJob.errorMessage).not.toContain('#1 [');
    expect(polledJob.errorMessage).not.toContain('key-a');
  });
});
