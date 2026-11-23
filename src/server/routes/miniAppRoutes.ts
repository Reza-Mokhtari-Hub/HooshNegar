import { Router, type Request, type Response } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { Api } from 'grammy';
import { getDb } from '../../db/index.ts';
import {
  aiRequests,
  conversationMessages,
  conversations,
  creditPackages,
  creditWallets,
  generationJobs,
  payments,
  storedFiles,
  subscriptionPlans,
  supportTickets,
  telegramAccounts,
  telegramBotSettings,
  users,
} from '../../db/schema.ts';
import type { CapabilityType } from '../../shared/validation.ts';
import { enqueueBackgroundJob } from '../queue/qstash.ts';
import { redactSecrets } from '../security/crypto.ts';
import { getStorageAdapter } from '../storage/storageAdapter.ts';
import { redeemGiftCreditCoupon } from '../services/referralCouponService.ts';
import { cancelSubscriptionAutoRenewal } from '../services/subscriptionService.ts';
import { createTelegramStarsOrder } from '../services/telegramStarsService.ts';
import { reserveCreditsAndCreateRequest, UsageGuardError } from '../services/usageService.ts';
import { reapStaleRunningJobs } from '../services/maintenanceService.ts';
import { executeQueuedGenerationJob } from '../telegram/jobRunner.ts';
import {
  authenticateMiniAppRequest,
  loadConfiguredBotForMiniApp,
  requireMiniAppAuth,
  verifyMiniAppSessionToken,
  type MiniAppRequest,
} from '../telegram/miniAppAuth.ts';
import {
  ensureTelegramUser,
  getAvailableModelsForUser,
  getOrCreateActiveConversation,
  getUserRecentPayments,
  getUserReferralDashboard,
  getUserUsageSnapshot,
  resolveSelectedModelForCapability,
  type EnsuredTelegramUser,
} from '../telegram/userService.ts';

const chatBodySchema = z.object({
  prompt: z.string().trim().min(1, 'متن پیام نمی‌تواند خالی باشد.').max(12000),
  conversationId: z.string().uuid().optional().nullable(),
  modelId: z.string().uuid().optional().nullable(),
});

const generateBodySchema = z.object({
  capability: z.enum([
    'image_generation',
    'speech_generation',
    'audio_transcription',
    'video_generation',
  ]),
  prompt: z.string().trim().max(4000).optional().default(''),
  modelId: z.string().uuid().optional().nullable(),
  aspectRatio: z.string().trim().max(16).optional(),
  resolution: z.string().trim().max(16).optional(),
  voice: z.string().trim().max(32).optional(),
  language: z.string().trim().max(16).optional(),
  durationSeconds: z.number().int().min(3).max(15).optional(),
  quality: z.string().trim().max(16).optional(),
  audioBase64: z.string().max(12_000_000).optional(),
  mimeType: z.string().trim().max(100).optional(),
  fileName: z.string().trim().max(160).optional(),
});

const preferencesSchema = z.object({
  locale: z.enum(['fa', 'en']).optional(),
  systemPrompt: z.string().max(2000).optional(),
  selectedTextModelId: z.string().uuid().nullable().optional(),
  selectedImageModelId: z.string().uuid().nullable().optional(),
  selectedAudioModelId: z.string().uuid().nullable().optional(),
  selectedVideoModelId: z.string().uuid().nullable().optional(),
  selectedDocumentModelId: z.string().uuid().nullable().optional(),
});

const invoiceSchema = z.object({
  kind: z.enum(['subscription', 'credit_package']),
  planId: z.string().uuid().optional(),
  creditPackageId: z.string().uuid().optional(),
  couponCode: z.string().trim().max(64).optional().nullable(),
});

const couponSchema = z.object({
  code: z.string().trim().min(2, 'کد هدیه معتبر وارد کنید.').max(64),
});

const supportSchema = z.object({
  category: z.enum(['general', 'payment', 'refund', 'failed_request']).default('general'),
  subject: z.string().trim().min(2, 'عنوان تیکت الزامی است.').max(200),
  message: z.string().trim().min(4, 'توضیحات تیکت را بنویسید.').max(4000),
});

async function buildBootstrapPayload(ensured: EnsuredTelegramUser, sessionToken: string) {
  const db = getDb();
  const [
    usage,
    models,
    plans,
    packages,
    referralDashboard,
    recentPayments,
    convs,
    botRows,
  ] = await Promise.all([
    getUserUsageSnapshot(ensured.user.id),
    getAvailableModelsForUser({ userId: ensured.user.id }),
    db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.isEnabled, true))
      .orderBy(subscriptionPlans.sortOrder),
    db
      .select()
      .from(creditPackages)
      .where(eq(creditPackages.isActive, true))
      .orderBy(creditPackages.sortOrder),
    getUserReferralDashboard(ensured.user.id),
    getUserRecentPayments(ensured.user.id),
    db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, ensured.user.id))
      .orderBy(desc(conversations.updatedAt))
      .limit(12),
    db
      .select({
        botUsername: telegramBotSettings.botUsername,
        botDisplayName: telegramBotSettings.botDisplayName,
        supportUsername: telegramBotSettings.supportUsername,
        welcomeMessage: telegramBotSettings.welcomeMessage,
        isActive: telegramBotSettings.isActive,
      })
      .from(telegramBotSettings)
      .where(eq(telegramBotSettings.singletonKey, 'primary'))
      .limit(1),
  ]);

  const botCfg = botRows[0];
  let activeConversation =
    convs.find((c) => c.id === ensured.telegramAccount.activeConversationId) ?? convs[0] ?? null;

  if (!activeConversation) {
    const defaultTextModel = await resolveSelectedModelForCapability({
      userId: ensured.user.id,
      telegramAccount: ensured.telegramAccount,
      capability: 'chat',
    });
    activeConversation = await getOrCreateActiveConversation({
      userId: ensured.user.id,
      telegramAccount: ensured.telegramAccount,
      modelId: defaultTextModel?.id ?? null,
    });
  }

  const messages = activeConversation
    ? await db
        .select({
          id: conversationMessages.id,
          role: conversationMessages.role,
          content: conversationMessages.content,
          createdAt: conversationMessages.createdAt,
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, activeConversation.id))
        .orderBy(asc(conversationMessages.createdAt))
        .limit(80)
    : [];

  return {
    sessionToken,
    user: {
      id: ensured.user.id,
      locale: ensured.user.locale,
      status: ensured.user.status,
      telegramUserId: ensured.telegramAccount.telegramUserId,
      username: ensured.telegramAccount.username,
      displayName:
        ensured.profile?.displayName ||
        ensured.telegramAccount.firstName ||
        ensured.telegramAccount.username ||
        'کاربر هوش‌نگار',
      isPremiumTelegram: ensured.telegramAccount.isPremiumTelegram,
      isNewUser: ensured.isNewUser,
      referralApplied: ensured.referralApplied,
    },
    wallet: {
      balance: ensured.walletBalance,
      reservedBalance: ensured.reservedBalance,
      available: Math.max(0, ensured.walletBalance - ensured.reservedBalance),
    },
    plan: ensured.plan
      ? {
          id: ensured.plan.id,
          name: ensured.plan.name,
          tier: ensured.plan.tier,
          dailyRequestLimit: ensured.plan.dailyRequestLimit,
          monthlyRequestLimit: ensured.plan.monthlyRequestLimit,
          imageGenerationLimit: ensured.plan.imageGenerationLimit,
          audioGenerationLimit: ensured.plan.audioGenerationLimit,
          videoGenerationLimit: ensured.plan.videoGenerationLimit,
          maxFileSizeMb: ensured.plan.maxFileSizeMb,
          priorityQueue: ensured.plan.priorityQueue,
        }
      : null,
    subscription: ensured.subscription
      ? {
          id: ensured.subscription.id,
          status: ensured.subscription.status,
          endsAt: ensured.subscription.endsAt,
          autoRenew: ensured.subscription.autoRenew,
        }
      : null,
    usage,
    models,
    preferences: {
      locale: ensured.user.locale as 'fa' | 'en',
      systemPrompt: ensured.telegramAccount.systemPrompt ?? '',
      selectedTextModelId: ensured.telegramAccount.selectedTextModelId,
      selectedImageModelId: ensured.telegramAccount.selectedImageModelId,
      selectedAudioModelId: ensured.telegramAccount.selectedAudioModelId,
      selectedVideoModelId: ensured.telegramAccount.selectedVideoModelId,
      selectedDocumentModelId: ensured.telegramAccount.selectedDocumentModelId,
    },
    activeConversationId: activeConversation.id,
    conversations: convs.length > 0 ? convs : [activeConversation],
    messages,
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      description: p.description,
      starsPrice: p.starsPrice,
      durationDays: p.durationDays,
      creditAllocation: p.creditAllocation,
      dailyRequestLimit: p.dailyRequestLimit,
      isRecurringStars: p.isRecurringStars,
      features: p.features ?? [],
    })),
    creditPackages: packages.map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      description: pkg.description,
      creditsAmount: pkg.creditsAmount,
      bonusCredits: pkg.bonusCredits,
      starsPrice: pkg.starsPrice,
    })),
    recentPayments: recentPayments.map((p) => ({
      ...p,
      amount: Number(p.amount),
    })),
    referralDashboard,
    bot: {
      username: botCfg?.botUsername ?? '',
      displayName: botCfg?.botDisplayName || 'هوش‌نگار',
      supportUsername: botCfg?.supportUsername ?? '',
      welcomeMessage: botCfg?.welcomeMessage ?? '',
      isActive: Boolean(botCfg?.isActive),
    },
  };
}

function buildMediaUrl(objectKey: string | null | undefined, sessionToken: string): string | null {
  if (!objectKey) return null;
  const encodedKey = encodeURIComponent(objectKey);
  const encodedToken = encodeURIComponent(sessionToken);
  return `/api/miniapp/media?key=${encodedKey}&token=${encodedToken}`;
}

export function createMiniAppRouter(): Router {
  const router = Router();

  // Safe public metadata so /miniapp outside Telegram can render a clean bot launcher
  router.get('/public-info', async (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const [cfg] = await db
        .select({
          botUsername: telegramBotSettings.botUsername,
          botDisplayName: telegramBotSettings.botDisplayName,
          supportUsername: telegramBotSettings.supportUsername,
          welcomeMessage: telegramBotSettings.welcomeMessage,
          isActive: telegramBotSettings.isActive,
          hasToken: telegramBotSettings.maskedBotToken,
        })
        .from(telegramBotSettings)
        .where(eq(telegramBotSettings.singletonKey, 'primary'))
        .limit(1);

      res.json({
        botUsername: cfg?.botUsername ?? '',
        botDisplayName: cfg?.botDisplayName || 'هوش‌نگار',
        supportUsername: cfg?.supportUsername ?? '',
        welcomeMessage: cfg?.welcomeMessage ?? '',
        botReady: Boolean(cfg?.hasToken && cfg?.isActive),
      });
    } catch (err) {
      console.error('[miniapp/public-info]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت اطلاعات عمومی مینی‌اپ.' });
    }
  });

  // Authenticate via verified Telegram WebApp initData (returns sessionToken + full bootstrap)
  router.post('/auth', async (req: MiniAppRequest, res: Response) => {
    try {
      const auth = await authenticateMiniAppRequest(req);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error, code: auth.code });
        return;
      }
      const payload = await buildBootstrapPayload(auth.ensured, auth.sessionToken);
      res.json(payload);
    } catch (err) {
      console.error('[miniapp/auth]', redactSecrets(err instanceof Error ? err.message : 'unknown'));
      res.status(500).json({ error: 'خطا در راه‌اندازی نشست مینی‌اپ.' });
    }
  });

  // Protected media endpoint (accepts Bearer header OR signed ?token= for <img>/<audio>/<video>)
  router.get('/media', async (req: MiniAppRequest, res: Response) => {
    try {
      const objectKey = typeof req.query.key === 'string' ? req.query.key.trim() : '';
      if (!objectKey) {
        res.status(400).json({ error: 'کلید فایل مشخص نشده است.' });
        return;
      }

      let userId: string | null = null;
      const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
      if (queryToken) {
        const verified = verifyMiniAppSessionToken(queryToken);
        if (!verified.ok) {
          res.status(401).json({ error: 'توکن دسترسی فایل نامعتبر یا منقضی است.' });
          return;
        }
        const ensured = await ensureTelegramUser({
          telegramUserId: verified.payload.tgUserId,
          telegramChatId: verified.payload.tgUserId,
        });
        userId = ensured.user.id;
      } else {
        const auth = await authenticateMiniAppRequest(req);
        if (!auth.ok) {
          res.status(auth.status).json({ error: auth.error, code: auth.code });
          return;
        }
        userId = auth.ensured.user.id;
      }

      const db = getDb();
      const [fileRow] = await db
        .select({
          userId: storedFiles.userId,
          mimeType: storedFiles.mimeType,
          deletedAt: storedFiles.deletedAt,
        })
        .from(storedFiles)
        .where(eq(storedFiles.objectKey, objectKey))
        .limit(1);

      if (!fileRow || fileRow.deletedAt || fileRow.userId !== userId) {
        res.status(404).json({ error: 'فایل مورد نظر یافت نشد یا دسترسی مجاز نیست.' });
        return;
      }

      const data = await getStorageAdapter().getObject(objectKey);
      if (!data) {
        res.status(404).json({ error: 'محتوای فایل در فضای ذخیره‌سازی یافت نشد.' });
        return;
      }

      res.setHeader('Content-Type', fileRow.mimeType || data.mimeType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(data.buffer);
    } catch (err) {
      console.error('[miniapp/media]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در بازیابی فایل.' });
    }
  });

  // Authenticated routes below
  router.use(requireMiniAppAuth);

  router.get('/bootstrap', async (req: MiniAppRequest, res: Response) => {
    try {
      const auth = req.miniAppAuth!;
      const payload = await buildBootstrapPayload(auth.ensured, auth.sessionToken);
      res.json(payload);
    } catch (err) {
      console.error('[miniapp/bootstrap]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در بارگذاری اطلاعات مینی‌اپ.' });
    }
  });

  router.get('/conversations', async (req: MiniAppRequest, res: Response) => {
    try {
      const auth = req.miniAppAuth!;
      const db = getDb();
      const list = await db
        .select()
        .from(conversations)
        .where(eq(conversations.userId, auth.ensured.user.id))
        .orderBy(desc(conversations.updatedAt))
        .limit(20);
      res.json({
        conversations: list,
        activeConversationId: auth.ensured.telegramAccount.activeConversationId,
      });
    } catch {
      res.status(500).json({ error: 'خطا در دریافت لیست گفتگوها.' });
    }
  });

  router.post('/conversations', async (req: MiniAppRequest, res: Response) => {
    try {
      const auth = req.miniAppAuth!;
      const conv = await getOrCreateActiveConversation({
        userId: auth.ensured.user.id,
        telegramAccount: auth.ensured.telegramAccount,
        modelId: auth.ensured.telegramAccount.selectedTextModelId,
        forceNew: true,
        title: typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'گفتگوی جدید',
      });
      res.status(201).json({ conversation: conv, messages: [] });
    } catch {
      res.status(500).json({ error: 'خطا در ایجاد گفتگوی جدید.' });
    }
  });

  router.get('/conversations/:id/messages', async (req: MiniAppRequest, res: Response) => {
    try {
      const auth = req.miniAppAuth!;
      const conversationId = String(req.params.id ?? '');
      const db = getDb();
      const [conv] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, auth.ensured.user.id)))
        .limit(1);
      if (!conv) {
        res.status(404).json({ error: 'گفتگو یافت نشد.' });
        return;
      }

      await db
        .update(telegramAccounts)
        .set({ activeConversationId: conv.id, updatedAt: new Date() })
        .where(eq(telegramAccounts.id, auth.ensured.telegramAccount.id));

      const messages = await db
        .select({
          id: conversationMessages.id,
          role: conversationMessages.role,
          content: conversationMessages.content,
          createdAt: conversationMessages.createdAt,
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conv.id))
        .orderBy(asc(conversationMessages.createdAt))
        .limit(100);

      res.json({ conversation: conv, messages });
    } catch {
      res.status(500).json({ error: 'خطا در دریافت پیام‌های گفتگو.' });
    }
  });

  router.delete('/conversations/:id/messages', async (req: MiniAppRequest, res: Response) => {
    try {
      const auth = req.miniAppAuth!;
      const conversationId = String(req.params.id ?? '');
      const db = getDb();
      const [conv] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, auth.ensured.user.id)))
        .limit(1);
      if (!conv) {
        res.status(404).json({ error: 'گفتگو یافت نشد.' });
        return;
      }
      await db.delete(conversationMessages).where(eq(conversationMessages.conversationId, conv.id));
      await db
        .update(conversations)
        .set({ messageCount: 0, updatedAt: new Date() })
        .where(eq(conversations.id, conv.id));

      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'خطا در پاک‌سازی تاریخچه گفتگو.' });
    }
  });

  router.post('/chat', async (req: MiniAppRequest, res: Response) => {
    try {
      const parsed = chatBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'درخواست گفتگو نامعتبر است.' });
        return;
      }

      const auth = req.miniAppAuth!;
      const ensured = auth.ensured;
      const db = getDb();

      // Resolve selected or requested model
      let modelId = parsed.data.modelId ?? null;
      if (modelId) {
        const available = await getAvailableModelsForUser({
          userId: ensured.user.id,
          capability: 'chat',
        });
        const match = available.find((m) => m.id === modelId);
        if (!match) {
          res.status(400).json({ error: 'مدل انتخاب‌شده در دسترس یا مجاز برای پلن شما نیست.' });
          return;
        }
        if (match.id !== ensured.telegramAccount.selectedTextModelId) {
          await db
            .update(telegramAccounts)
            .set({ selectedTextModelId: match.id, updatedAt: new Date() })
            .where(eq(telegramAccounts.id, ensured.telegramAccount.id));
        }
      } else {
        const resolved = await resolveSelectedModelForCapability({
          userId: ensured.user.id,
          telegramAccount: ensured.telegramAccount,
          capability: 'chat',
        });
        if (!resolved) {
          res.status(400).json({ error: 'هیچ مدل متنی فعالی برای پلن شما تنظیم نشده است.' });
          return;
        }
        modelId = resolved.id;
      }

      // Resolve or create conversation
      let conv: typeof conversations.$inferSelect | undefined;
      if (parsed.data.conversationId) {
        const [found] = await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, parsed.data.conversationId),
              eq(conversations.userId, ensured.user.id),
            ),
          )
          .limit(1);
        conv = found;
      }
      if (!conv) {
        conv = await getOrCreateActiveConversation({
          userId: ensured.user.id,
          telegramAccount: ensured.telegramAccount,
          modelId,
          title: parsed.data.prompt.slice(0, 80),
        });
      }

      await db.insert(conversationMessages).values({
        conversationId: conv.id,
        role: 'user',
        content: parsed.data.prompt,
      });

      if (conv.messageCount === 0) {
        await db
          .update(conversations)
          .set({
            title: parsed.data.prompt.slice(0, 80),
            messageCount: 1,
            lastMessageAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conv.id));
      }

      const idempotencyKey = `miniapp:chat:${ensured.user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      let reserved;
      try {
        reserved = await reserveCreditsAndCreateRequest({
          userId: ensured.user.id,
          modelId,
          capability: 'chat',
          idempotencyKey,
          conversationId: conv.id,
          telegramChatId: ensured.telegramAccount.telegramChatId,
          promptPreview: parsed.data.prompt,
          jobPayload: {
            prompt: parsed.data.prompt,
            systemPrompt: ensured.telegramAccount.systemPrompt || undefined,
            silentDelivery: true,
          },
        });
      } catch (err) {
        if (err instanceof UsageGuardError) {
          res.status(400).json({ error: err.userMessageFa, code: err.code });
          return;
        }
        throw err;
      }

      const execRes = await executeQueuedGenerationJob(reserved.jobId);

      const [freshWallet] = await db
        .select({ balance: creditWallets.balance, reserved: creditWallets.reservedBalance })
        .from(creditWallets)
        .where(eq(creditWallets.userId, ensured.user.id))
        .limit(1);

      const messages = await db
        .select({
          id: conversationMessages.id,
          role: conversationMessages.role,
          content: conversationMessages.content,
          createdAt: conversationMessages.createdAt,
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conv.id))
        .orderBy(asc(conversationMessages.createdAt))
        .limit(100);

      if (!execRes.ok) {
        res.status(502).json({
          ok: false,
          error: execRes.error || 'خطا در تولید پاسخ هوش مصنوعی. اعتبار شما بازگردانده شد.',
          conversationId: conv.id,
          messages,
          wallet: {
            balance: Number(freshWallet?.balance ?? ensured.walletBalance),
            reservedBalance: Number(freshWallet?.reserved ?? 0),
          },
        });
        return;
      }

      res.json({
        ok: true,
        requestId: reserved.requestId,
        jobId: reserved.jobId,
        conversationId: conv.id,
        responseText: execRes.responseText ?? '',
        messages,
        wallet: {
          balance: Number(freshWallet?.balance ?? ensured.walletBalance),
          reservedBalance: Number(freshWallet?.reserved ?? 0),
        },
      });
    } catch (err) {
      console.error('[miniapp/chat]', redactSecrets(err instanceof Error ? err.message : 'unknown'));
      res.status(500).json({ error: 'خطای غیرمنتظره در پردازش گفتگو.' });
    }
  });

  router.post('/generate', async (req: MiniAppRequest, res: Response) => {
    try {
      const parsed = generateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'ورودی نامعتبر است.' });
        return;
      }

      const auth = req.miniAppAuth!;
      const ensured = auth.ensured;
      const d = parsed.data;
      const db = getDb();

      if (d.capability !== 'audio_transcription' && !d.prompt.trim()) {
        res.status(400).json({ error: 'لطفاً متن توصیفی (پرامپت) را وارد کنید.' });
        return;
      }
      if (d.capability === 'audio_transcription' && !d.audioBase64) {
        res.status(400).json({ error: 'فایل صوتی برای تبدیل به متن ارسال نشده است.' });
        return;
      }

      let modelId = d.modelId ?? null;
      if (modelId) {
        const available = await getAvailableModelsForUser({
          userId: ensured.user.id,
          capability: d.capability as CapabilityType,
        });
        if (!available.some((m) => m.id === modelId)) {
          res.status(400).json({ error: 'مدل انتخاب‌شده برای این قابلیت یا پلن شما مجاز نیست.' });
          return;
        }
      } else {
        const resolved = await resolveSelectedModelForCapability({
          userId: ensured.user.id,
          telegramAccount: ensured.telegramAccount,
          capability: d.capability as CapabilityType,
        });
        if (!resolved) {
          res.status(400).json({ error: 'هیچ مدل فعالی برای این قابلیت در پلن شما تعریف نشده است.' });
          return;
        }
        modelId = resolved.id;
      }

      const jobPayload: Record<string, unknown> = {
        prompt: d.prompt,
        aspectRatio: d.aspectRatio ?? (d.capability === 'video_generation' ? '16:9' : '1:1'),
        resolution: d.resolution ?? '1K',
        voice: d.voice ?? 'Kore',
        language: d.language ?? 'fa',
        durationSeconds: d.durationSeconds ?? 5,
        quality: d.quality ?? '720p',
        silentDelivery: true,
      };
      if (d.audioBase64) {
        jobPayload.audioBase64 = d.audioBase64;
        jobPayload.mimeType = d.mimeType ?? 'audio/webm';
        jobPayload.fileName = d.fileName ?? 'recording.webm';
      }

      const idempotencyKey = `miniapp:${d.capability}:${ensured.user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      let reserved;
      try {
        reserved = await reserveCreditsAndCreateRequest({
          userId: ensured.user.id,
          modelId,
          capability: d.capability as CapabilityType,
          idempotencyKey,
          telegramChatId: ensured.telegramAccount.telegramChatId,
          promptPreview: d.prompt || `فایل صوتی (${d.fileName ?? 'audio'})`,
          jobPayload,
        });
      } catch (err) {
        if (err instanceof UsageGuardError) {
          res.status(400).json({ error: err.userMessageFa, code: err.code });
          return;
        }
        throw err;
      }

      const execRes = await executeQueuedGenerationJob(reserved.jobId);
      const [freshWallet] = await db
        .select({ balance: creditWallets.balance, reserved: creditWallets.reservedBalance })
        .from(creditWallets)
        .where(eq(creditWallets.userId, ensured.user.id))
        .limit(1);

      if (!execRes.ok) {
        res.status(502).json({
          ok: false,
          error: execRes.error || 'خطا در اجرای پردازش. اعتبار رزروشده بازگردانده شد.',
          jobId: reserved.jobId,
          wallet: {
            balance: Number(freshWallet?.balance ?? ensured.walletBalance),
            reservedBalance: Number(freshWallet?.reserved ?? 0),
          },
        });
        return;
      }

      res.json({
        ok: true,
        requestId: reserved.requestId,
        jobId: reserved.jobId,
        status: execRes.status,
        responseText: execRes.responseText ?? null,
        storageObjectKey: execRes.storageObjectKey ?? null,
        mediaUrl: buildMediaUrl(execRes.storageObjectKey, auth.sessionToken),
        wallet: {
          balance: Number(freshWallet?.balance ?? ensured.walletBalance),
          reservedBalance: Number(freshWallet?.reserved ?? 0),
        },
      });
    } catch (err) {
      console.error('[miniapp/generate]', redactSecrets(err instanceof Error ? err.message : 'unknown'));
      res.status(500).json({ error: 'خطای غیرمنتظره در پردازش رسانه.' });
    }
  });

  router.get('/jobs/:id', async (req: MiniAppRequest, res: Response) => {
    try {
      const auth = req.miniAppAuth!;
      const jobId = String(req.params.id ?? '');
      const db = getDb();

      let [job] = await db
        .select()
        .from(generationJobs)
        .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, auth.ensured.user.id)))
        .limit(1);

      if (!job) {
        res.status(404).json({ error: 'پردازش مورد نظر یافت نشد.' });
        return;
      }

      if (job.status === 'running' || job.status === 'queued') {
        const reaped = await reapStaleRunningJobs().catch(() => 0);
        if (reaped > 0) {
          const [refreshed] = await db
            .select()
            .from(generationJobs)
            .where(and(eq(generationJobs.id, jobId), eq(generationJobs.userId, auth.ensured.user.id)))
            .limit(1);
          if (refreshed) job = refreshed;
        }
      }

      const [reqRow] = await db
        .select({ responsePreview: aiRequests.responsePreview })
        .from(aiRequests)
        .where(eq(aiRequests.id, job.requestId))
        .limit(1);

      const [freshWallet] = await db
        .select({ balance: creditWallets.balance, reserved: creditWallets.reservedBalance })
        .from(creditWallets)
        .where(eq(creditWallets.userId, auth.ensured.user.id))
        .limit(1);

      res.json({
        job: {
          id: job.id,
          status: job.status,
          capability: job.capability,
          progressPercent: job.progressPercent,
          responseText: reqRow?.responsePreview ?? null,
          storageObjectKey: job.storageObjectKey,
          mediaUrl: buildMediaUrl(job.storageObjectKey, auth.sessionToken),
          errorMessage:
            job.status === 'failed'
              ? 'امکان تکمیل این درخواست با مدل انتخابی وجود نداشت. لطفاً مدل دیگری انتخاب کنید یا دوباره تلاش نمایید.'
              : null,
        },
        wallet: {
          balance: Number(freshWallet?.balance ?? auth.ensured.walletBalance),
          reservedBalance: Number(freshWallet?.reserved ?? 0),
        },
      });
    } catch {
      res.status(500).json({ error: 'خطا در بررسی وضعیت پردازش.' });
    }
  });

  router.patch('/preferences', async (req: MiniAppRequest, res: Response) => {
    try {
      const parsed = preferencesSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'تنظیمات ارسالی نامعتبر است.' });
        return;
      }

      const auth = req.miniAppAuth!;
      const db = getDb();
      const d = parsed.data;
      const now = new Date();

      if (d.locale) {
        await db
          .update(users)
          .set({ locale: d.locale, updatedAt: now })
          .where(eq(users.id, auth.ensured.user.id));
      }

      const tgPatch: Partial<typeof telegramAccounts.$inferInsert> = { updatedAt: now };
      if (d.systemPrompt !== undefined) tgPatch.systemPrompt = d.systemPrompt.trim();
      if (d.selectedTextModelId !== undefined) tgPatch.selectedTextModelId = d.selectedTextModelId;
      if (d.selectedImageModelId !== undefined) tgPatch.selectedImageModelId = d.selectedImageModelId;
      if (d.selectedAudioModelId !== undefined) tgPatch.selectedAudioModelId = d.selectedAudioModelId;
      if (d.selectedVideoModelId !== undefined) tgPatch.selectedVideoModelId = d.selectedVideoModelId;
      if (d.selectedDocumentModelId !== undefined) tgPatch.selectedDocumentModelId = d.selectedDocumentModelId;

      await db
        .update(telegramAccounts)
        .set(tgPatch)
        .where(eq(telegramAccounts.id, auth.ensured.telegramAccount.id));

      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'خطا در ذخیره تنظیمات کاربر.' });
    }
  });

  router.post('/invoice', async (req: MiniAppRequest, res: Response) => {
    try {
      const parsed = invoiceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'مشخصات فاکتور نامعتبر است.' });
        return;
      }

      const auth = req.miniAppAuth!;
      const botCfg = await loadConfiguredBotForMiniApp();
      if (!botCfg) {
        res.status(503).json({ error: 'توکن ربات تلگرام هنوز تنظیم نشده است.' });
        return;
      }

      const order = await createTelegramStarsOrder({
        userId: auth.ensured.user.id,
        telegramUserId: auth.telegramUserId,
        kind: parsed.data.kind,
        planId: parsed.data.planId,
        creditPackageId: parsed.data.creditPackageId,
        couponCode: parsed.data.couponCode ?? null,
      });

      const safeFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init)) as unknown as NonNullable<
        ConstructorParameters<typeof Api>[1]
      >['fetch'];
      const api = new Api(botCfg.botToken, { fetch: safeFetch });

      const invoiceUrl = await api.createInvoiceLink(
        order.title,
        order.description,
        order.invoicePayload,
        '',
        'XTR',
        [{ label: order.label, amount: order.starsAmount }],
        order.isRecurring && order.subscriptionPeriodSeconds
          ? { subscription_period: order.subscriptionPeriodSeconds }
          : undefined,
      );

      res.json({
        ok: true,
        paymentId: order.paymentId,
        orderNumber: order.orderNumber,
        invoiceUrl,
        starsAmount: order.starsAmount,
        discountStars: order.discountStars,
        title: order.title,
        isRecurring: order.isRecurring,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'خطا در ایجاد فاکتور تلگرام استارز.';
      res.status(400).json({ error: msg });
    }
  });

  router.post('/subscription/cancel', async (req: MiniAppRequest, res: Response) => {
    try {
      const auth = req.miniAppAuth!;
      const result = await cancelSubscriptionAutoRenewal({
        userId: auth.ensured.user.id,
        reason: 'Canceled by user via Telegram Mini App',
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch {
      res.status(500).json({ error: 'خطا در لغو تمدید خودکار اشتراک.' });
    }
  });

  router.post('/coupon', async (req: MiniAppRequest, res: Response) => {
    try {
      const parsed = couponSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'کد هدیه نامعتبر است.' });
        return;
      }

      const auth = req.miniAppAuth!;
      const result = await redeemGiftCreditCoupon({
        userId: auth.ensured.user.id,
        code: parsed.data.code,
      });

      if (!result.ok) {
        res.status(400).json({ error: result.errorFa ?? 'کد هدیه معتبر نیست.' });
        return;
      }

      res.json({
        ok: true,
        creditsAwarded: result.creditsAwarded ?? 0,
        newBalance: result.newBalance ?? auth.ensured.walletBalance,
      });
    } catch {
      res.status(500).json({ error: 'خطا در اعمال کد هدیه.' });
    }
  });

  router.post('/support', async (req: MiniAppRequest, res: Response) => {
    try {
      const parsed = supportSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'اطلاعات تیکت نامعتبر است.' });
        return;
      }

      const auth = req.miniAppAuth!;
      const db = getDb();
      const d = parsed.data;

      let relatedPaymentId: string | null = null;
      let relatedRequestId: string | null = null;
      if (d.category === 'payment' || d.category === 'refund') {
        const [latestPay] = await db
          .select({ id: payments.id })
          .from(payments)
          .where(eq(payments.userId, auth.ensured.user.id))
          .orderBy(desc(payments.createdAt))
          .limit(1);
        relatedPaymentId = latestPay?.id ?? null;
      } else if (d.category === 'failed_request') {
        const [latestFail] = await db
          .select({ id: aiRequests.id })
          .from(aiRequests)
          .where(and(eq(aiRequests.userId, auth.ensured.user.id), eq(aiRequests.status, 'failed')))
          .orderBy(desc(aiRequests.createdAt))
          .limit(1);
        relatedRequestId = latestFail?.id ?? null;
      }

      const [ticket] = await db
        .insert(supportTickets)
        .values({
          userId: auth.ensured.user.id,
          category: d.category,
          relatedPaymentId,
          relatedRequestId,
          subject: d.subject,
          message: d.message,
          priority: d.category === 'payment' || d.category === 'refund' ? 'high' : 'medium',
          status: 'open',
        })
        .returning({ id: supportTickets.id, createdAt: supportTickets.createdAt });

      res.status(201).json({
        ok: true,
        ticketId: ticket?.id,
        trackingCode: ticket?.id.slice(0, 8),
      });
    } catch {
      res.status(500).json({ error: 'خطا در ثبت تیکت پشتیبانی.' });
    }
  });

  // Unused import guard for enqueueBackgroundJob if async queue extensions needed
  void enqueueBackgroundJob;

  return router;
}
