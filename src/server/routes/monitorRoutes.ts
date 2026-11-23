import { Router, type Response } from 'express';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiProviders,
  aiRequests,
  conversationMessages,
  conversations,
  creditTransactions,
  creditWallets,
  generationJobs,
  storedFiles,
  subscriptionPlans,
  telegramAccounts,
  telegramBotSettings,
  userProfiles,
  users,
  userSubscriptions,
  webhookEvents,
} from '../../db/schema.ts';
import { getEnvValidationSummary, isAiMockModeEnabled } from '../config/env.ts';
import { getCloudflareJobQueue } from '../cloudflare/requestContext.ts';
import { enqueueBackgroundJob } from '../queue/qstash.ts';
import { refundFailedRequest } from '../services/usageService.ts';
import { reapStaleRunningJobs } from '../services/maintenanceService.ts';
import { runEndToEndTelegramSimulation } from '../telegram/bot.ts';
import { recordAuditLog } from '../security/audit.ts';
import {
  getClientIp,
  requireAdminAuth,
  requireRole,
  type AdminRequest,
} from '../middleware/auth.ts';
import type { CapabilityType } from '../../shared/validation.ts';

export function createMonitorRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);

  // =========================================================================
  // 1. TELEGRAM BOT MONITOR
  // =========================================================================
  router.get('/monitor/bot', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [
        [botCfg],
        [tgUsersCount],
        [conversationsCount],
        [activeJobsCount],
        [storedFilesCount],
        [webhookTotal],
        [webhookFailed],
        recentEvents,
      ] = await Promise.all([
        db
          .select({
            botUsername: telegramBotSettings.botUsername,
            botDisplayName: telegramBotSettings.botDisplayName,
            webhookUrl: telegramBotSettings.webhookUrl,
            isActive: telegramBotSettings.isActive,
            connectionStatus: telegramBotSettings.connectionStatus,
            lastTestedAt: telegramBotSettings.lastTestedAt,
            lastTestMessage: telegramBotSettings.lastTestMessage,
            hasBotToken: sql<boolean>`${telegramBotSettings.encryptedBotToken} is not null`,
            hasWebhookSecret: sql<boolean>`${telegramBotSettings.encryptedWebhookSecret} is not null`,
          })
          .from(telegramBotSettings)
          .where(eq(telegramBotSettings.singletonKey, 'primary'))
          .limit(1),
        db.select({ total: count() }).from(telegramAccounts),
        db.select({ total: count() }).from(conversations),
        db
          .select({ total: count() })
          .from(generationJobs)
          .where(inArray(generationJobs.status, ['queued', 'running'])),
        db.select({ total: count() }).from(storedFiles),
        db
          .select({ total: count() })
          .from(webhookEvents)
          .where(eq(webhookEvents.source, 'telegram')),
        db
          .select({ total: count() })
          .from(webhookEvents)
          .where(and(eq(webhookEvents.source, 'telegram'), eq(webhookEvents.status, 'failed'))),
        db
          .select({
            id: webhookEvents.id,
            externalEventId: webhookEvents.idempotencyKey,
            eventType: webhookEvents.eventType,
            signatureVerified: sql<boolean>`coalesce((${webhookEvents.payload}->>'signatureVerified')::boolean, true)`,
            status: webhookEvents.status,
            errorMessage: webhookEvents.errorMessage,
            receivedAt: webhookEvents.createdAt,
            processedAt: webhookEvents.processedAt,
          })
          .from(webhookEvents)
          .where(eq(webhookEvents.source, 'telegram'))
          .orderBy(desc(webhookEvents.createdAt))
          .limit(30),
      ]);

      const env = getEnvValidationSummary();

      res.json({
        bot: botCfg ?? null,
        summary: {
          connectedTelegramUsers: tgUsersCount?.total ?? 0,
          totalConversations: conversationsCount?.total ?? 0,
          activeJobs: activeJobsCount?.total ?? 0,
          storedMediaFiles: storedFilesCount?.total ?? 0,
          totalWebhookEvents: webhookTotal?.total ?? 0,
          failedWebhookEvents: webhookFailed?.total ?? 0,
        },
        infrastructure: {
          qstashConfigured: env.qstashConfigured,
          cfQueueConfigured: Boolean(getCloudflareJobQueue()),
          r2Configured: env.r2Configured,
          aiMockMode: env.aiMockMode,
          databaseMode: env.databaseMode,
        },
        recentEvents,
      });
    } catch (err) {
      console.error('[monitor/bot]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت وضعیت پایش ربات تلگرام.' });
    }
  });

  // Dev/Mock-only pipeline test trigger (strictly blocked in production)
  router.post(
    '/monitor/bot/simulate',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      if (!isAiMockModeEnabled()) {
        res.status(403).json({
          error: 'شبیه‌ساز تست فقط در محیط توسعه با AI_MOCK_MODE=true فعال است.',
          code: 'MOCK_MODE_DISABLED',
        });
        return;
      }
      try {
        const telegramUserId = Number(req.body?.telegramUserId ?? 700001);
        const prompt = String(req.body?.prompt ?? 'سلام! یک معرفی کوتاه از هوش‌نگار بنویس.').trim();
        const capability = (req.body?.capability ?? 'chat') as CapabilityType;
        const username = typeof req.body?.username === 'string' ? req.body.username : 'dev_tester';
        const firstName = typeof req.body?.firstName === 'string' ? req.body.firstName : 'کاربر آزمایشی';
        const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : undefined;

        const out = await runEndToEndTelegramSimulation({
          telegramUserId,
          username,
          firstName,
          prompt,
          capability,
          modelId,
        });

        res.json({
          ok: out.execution.ok,
          userId: out.ensured.user.id,
          requestId: out.reserved.requestId,
          jobId: out.reserved.jobId,
          status: out.execution.status,
          responseText: out.execution.responseText,
          storageObjectKey: out.execution.storageObjectKey,
        });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'خطا در اجرای تست شبیه‌سازی.',
        });
      }
    },
  );

  // =========================================================================
  // 2. CONNECTED TELEGRAM USERS & USAGE HISTORY
  // =========================================================================
  router.get('/monitor/connected-users', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [rows, reqCounts, subs] = await Promise.all([
        db
          .select({
            userId: users.id,
            status: users.status,
            locale: users.locale,
            createdAt: users.createdAt,
            lastActiveAt: users.lastActiveAt,
            displayName: userProfiles.displayName,
            telegramAccountId: telegramAccounts.id,
            telegramUserId: telegramAccounts.telegramUserId,
            username: telegramAccounts.username,
            firstName: telegramAccounts.firstName,
            lastName: telegramAccounts.lastName,
            languageCode: telegramAccounts.languageCode,
            isPremiumTelegram: telegramAccounts.isPremiumTelegram,
            lastInteractionAt: telegramAccounts.lastInteractionAt,
            walletBalance: creditWallets.balance,
            reservedBalance: creditWallets.reservedBalance,
            lifetimeSpent: creditWallets.lifetimeSpent,
          })
          .from(telegramAccounts)
          .innerJoin(users, eq(telegramAccounts.userId, users.id))
          .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
          .leftJoin(creditWallets, eq(creditWallets.userId, users.id))
          .orderBy(desc(telegramAccounts.lastInteractionAt))
          .limit(150),
        db
          .select({
            userId: aiRequests.userId,
            totalRequests: count(),
            failedRequests: sql<number>`count(*) filter (where ${aiRequests.status} = 'failed')`,
          })
          .from(aiRequests)
          .groupBy(aiRequests.userId),
        db
          .select({
            userId: userSubscriptions.userId,
            planName: subscriptionPlans.name,
            planTier: subscriptionPlans.tier,
            endsAt: userSubscriptions.endsAt,
          })
          .from(userSubscriptions)
          .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
          .where(eq(userSubscriptions.status, 'active'))
          .orderBy(desc(userSubscriptions.endsAt)),
      ]);

      const reqMap = new Map(reqCounts.map((r) => [r.userId, r]));
      const subMap = new Map<string, { planName: string; planTier: string; endsAt: Date }>();
      for (const s of subs) {
        if (!subMap.has(s.userId)) subMap.set(s.userId, s);
      }

      res.json({
        users: rows.map((r) => {
          const stats = reqMap.get(r.userId);
          const sub = subMap.get(r.userId);
          return {
            ...r,
            walletBalance: Number(r.walletBalance ?? 0),
            reservedBalance: Number(r.reservedBalance ?? 0),
            lifetimeSpent: Number(r.lifetimeSpent ?? 0),
            totalRequests: Number(stats?.totalRequests ?? 0),
            failedRequests: Number(stats?.failedRequests ?? 0),
            planName: sub?.planName ?? 'بدون اشتراک',
            planTier: sub?.planTier ?? 'free',
          };
        }),
      });
    } catch (err) {
      console.error('[monitor/connected-users]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت فهرست کاربران متصل تلگرام.' });
    }
  });

  router.get('/monitor/connected-users/:userId/history', async (req: AdminRequest, res: Response) => {
    const userId = String(req.params.userId ?? '');
    try {
      const db = getDb();
      const [recentRequests, recentTransactions, recentConversations] = await Promise.all([
        db
          .select({
            id: aiRequests.id,
            capability: aiRequests.capability,
            status: aiRequests.status,
            modelName: aiModels.name,
            providerName: aiProviders.name,
            creditsCharged: aiRequests.creditsCharged,
            latencyMs: aiRequests.latencyMs,
            promptPreview: aiRequests.promptPreview,
            errorMessage: aiRequests.errorMessage,
            createdAt: aiRequests.createdAt,
          })
          .from(aiRequests)
          .leftJoin(aiModels, eq(aiRequests.modelId, aiModels.id))
          .leftJoin(aiProviders, eq(aiRequests.providerId, aiProviders.id))
          .where(eq(aiRequests.userId, userId))
          .orderBy(desc(aiRequests.createdAt))
          .limit(30),
        db
          .select({
            id: creditTransactions.id,
            type: creditTransactions.type,
            amount: creditTransactions.amount,
            balanceAfter: creditTransactions.balanceAfter,
            description: creditTransactions.description,
            createdAt: creditTransactions.createdAt,
          })
          .from(creditTransactions)
          .where(eq(creditTransactions.userId, userId))
          .orderBy(desc(creditTransactions.createdAt))
          .limit(30),
        db
          .select({
            id: conversations.id,
            title: conversations.title,
            messageCount: conversations.messageCount,
            lastMessageAt: conversations.lastMessageAt,
          })
          .from(conversations)
          .where(eq(conversations.userId, userId))
          .orderBy(desc(conversations.updatedAt))
          .limit(15),
      ]);

      res.json({
        requests: recentRequests.map((r) => ({ ...r, creditsCharged: Number(r.creditsCharged) })),
        transactions: recentTransactions.map((t) => ({
          ...t,
          amount: Number(t.amount),
          balanceAfter: Number(t.balanceAfter),
        })),
        conversations: recentConversations,
      });
    } catch (err) {
      console.error('[monitor/user-history]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت تاریخچه مصرف کاربر.' });
    }
  });

  // =========================================================================
  // 3. CONVERSATION LOGS
  // =========================================================================
  router.get('/monitor/conversations', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const rows = await db
        .select({
          id: conversations.id,
          userId: conversations.userId,
          title: conversations.title,
          status: conversations.status,
          messageCount: conversations.messageCount,
          lastMessageAt: conversations.lastMessageAt,
          createdAt: conversations.createdAt,
          modelName: aiModels.name,
          telegramUsername: telegramAccounts.username,
          telegramUserId: telegramAccounts.telegramUserId,
          displayName: userProfiles.displayName,
        })
        .from(conversations)
        .leftJoin(aiModels, eq(conversations.modelId, aiModels.id))
        .leftJoin(telegramAccounts, eq(conversations.telegramAccountId, telegramAccounts.id))
        .leftJoin(userProfiles, eq(userProfiles.userId, conversations.userId))
        .orderBy(desc(conversations.updatedAt))
        .limit(100);

      res.json({ conversations: rows });
    } catch (err) {
      console.error('[monitor/conversations]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت گزارش گفتگوها.' });
    }
  });

  router.get('/monitor/conversations/:id/messages', async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    try {
      const db = getDb();
      const messages = await db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, id))
        .orderBy(asc(conversationMessages.createdAt))
        .limit(100);

      res.json({ messages });
    } catch (err) {
      console.error('[monitor/conv-messages]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت پیام‌های گفتگو.' });
    }
  });

  // =========================================================================
  // 4. AI REQUESTS & FAILED REQUESTS
  // =========================================================================
  router.get('/monitor/requests', async (req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const statusFilter = typeof req.query.status === 'string' ? req.query.status : '';
      const failedOnly = req.query.failedOnly === 'true';

      const conditions = [];
      if (failedOnly) {
        conditions.push(inArray(aiRequests.status, ['failed', 'canceled']));
      } else if (
        statusFilter &&
        ['queued', 'running', 'succeeded', 'failed', 'canceled'].includes(statusFilter)
      ) {
        conditions.push(
          eq(
            aiRequests.status,
            statusFilter as 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled',
          ),
        );
      }

      const rows = await db
        .select({
          id: aiRequests.id,
          userId: aiRequests.userId,
          capability: aiRequests.capability,
          status: aiRequests.status,
          inputTokens: aiRequests.inputTokens,
          outputTokens: aiRequests.outputTokens,
          creditsCharged: aiRequests.creditsCharged,
          costUsd: aiRequests.costUsd,
          latencyMs: aiRequests.latencyMs,
          promptPreview: aiRequests.promptPreview,
          responsePreview: aiRequests.responsePreview,
          retryCount: aiRequests.retryCount,
          usedFallback: aiRequests.usedFallback,
          errorCode: aiRequests.errorCode,
          errorMessage: aiRequests.errorMessage,
          createdAt: aiRequests.createdAt,
          completedAt: aiRequests.completedAt,
          providerName: aiProviders.name,
          modelName: aiModels.name,
          telegramUsername: telegramAccounts.username,
          displayName: userProfiles.displayName,
        })
        .from(aiRequests)
        .leftJoin(aiProviders, eq(aiRequests.providerId, aiProviders.id))
        .leftJoin(aiModels, eq(aiRequests.modelId, aiModels.id))
        .leftJoin(telegramAccounts, eq(telegramAccounts.userId, aiRequests.userId))
        .leftJoin(userProfiles, eq(userProfiles.userId, aiRequests.userId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(aiRequests.createdAt))
        .limit(120);

      res.json({
        requests: rows.map((r) => ({
          ...r,
          creditsCharged: Number(r.creditsCharged),
          costUsd: Number(r.costUsd),
        })),
      });
    } catch (err) {
      console.error('[monitor/requests]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت فهرست درخواست‌های هوش مصنوعی.' });
    }
  });

  router.get('/monitor/failed-requests', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const rows = await db
        .select({
          id: aiRequests.id,
          userId: aiRequests.userId,
          capability: aiRequests.capability,
          status: aiRequests.status,
          creditsCharged: aiRequests.creditsCharged,
          latencyMs: aiRequests.latencyMs,
          promptPreview: aiRequests.promptPreview,
          retryCount: aiRequests.retryCount,
          errorCode: aiRequests.errorCode,
          errorMessage: aiRequests.errorMessage,
          createdAt: aiRequests.createdAt,
          completedAt: aiRequests.completedAt,
          providerName: aiProviders.name,
          modelName: aiModels.name,
          telegramUsername: telegramAccounts.username,
        })
        .from(aiRequests)
        .leftJoin(aiProviders, eq(aiRequests.providerId, aiProviders.id))
        .leftJoin(aiModels, eq(aiRequests.modelId, aiModels.id))
        .leftJoin(telegramAccounts, eq(telegramAccounts.userId, aiRequests.userId))
        .where(inArray(aiRequests.status, ['failed', 'canceled']))
        .orderBy(desc(aiRequests.createdAt))
        .limit(100);

      res.json({
        failedRequests: rows.map((r) => ({
          ...r,
          creditsCharged: Number(r.creditsCharged),
        })),
      });
    } catch (err) {
      console.error('[monitor/failed-requests]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت درخواست‌های ناموفق.' });
    }
  });

  // =========================================================================
  // 5. GENERATION JOBS (Monitor + Retry + Cancel)
  // =========================================================================
  router.get('/monitor/jobs', async (_req: AdminRequest, res: Response) => {
    try {
      await reapStaleRunningJobs().catch(() => 0);
      const db = getDb();
      const rows = await db
        .select({
          id: generationJobs.id,
          requestId: generationJobs.requestId,
          userId: generationJobs.userId,
          capability: generationJobs.capability,
          status: generationJobs.status,
          progressPercent: generationJobs.progressPercent,
          attempts: generationJobs.attempts,
          maxAttempts: generationJobs.maxAttempts,
          providerJobId: generationJobs.providerJobId,
          storageObjectKey: generationJobs.storageObjectKey,
          errorCode: aiRequests.errorCode,
          errorMessage: generationJobs.errorMessage,
          startedAt: generationJobs.startedAt,
          finishedAt: generationJobs.finishedAt,
          createdAt: generationJobs.createdAt,
          modelName: aiModels.name,
          providerName: aiProviders.name,
          telegramUsername: telegramAccounts.username,
        })
        .from(generationJobs)
        .leftJoin(aiRequests, eq(generationJobs.requestId, aiRequests.id))
        .leftJoin(aiModels, eq(aiRequests.modelId, aiModels.id))
        .leftJoin(aiProviders, eq(aiRequests.providerId, aiProviders.id))
        .leftJoin(telegramAccounts, eq(telegramAccounts.userId, generationJobs.userId))
        .orderBy(desc(generationJobs.createdAt))
        .limit(100);

      res.json({ jobs: rows });
    } catch (err) {
      console.error('[monitor/jobs]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت فهرست کارهای تولید پس‌زمینه.' });
    }
  });

  router.post(
    '/monitor/jobs/:id/retry',
    requireRole('operator'),
    async (req: AdminRequest, res: Response) => {
      const jobId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const db = getDb();
        const [job] = await db
          .select()
          .from(generationJobs)
          .where(eq(generationJobs.id, jobId))
          .limit(1);

        if (!job) {
          res.status(404).json({ error: 'کار مورد نظر یافت نشد.' });
          return;
        }

        await db
          .update(generationJobs)
          .set({
            status: 'queued',
            progressPercent: 5,
            errorMessage: null,
            finishedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(generationJobs.id, job.id));

        await db
          .update(aiRequests)
          .set({ status: 'queued', errorCode: null, errorMessage: null })
          .where(eq(aiRequests.id, job.requestId));

        const pollKind =
          job.providerJobId && job.capability === 'video_generation'
            ? 'video_poll_job'
            : job.providerJobId &&
                (job.capability === 'image_generation' ||
                  job.capability === 'image_editing' ||
                  job.capability === 'image_variation')
              ? 'media_poll_job'
              : 'ai_generation_job';

        await enqueueBackgroundJob({
          kind: pollKind,
          idempotencyKey: `retry:${job.id}:${Date.now()}`,
          jobId: job.id,
          requestId: job.requestId,
        });

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'job.retried',
          resourceType: 'generation_job',
          resourceId: job.id,
          ipAddress: ip,
          userAgent: ua,
          details: { capability: job.capability },
        });

        res.json({ ok: true });
      } catch (err) {
        console.error('[monitor/jobs/retry]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در ارسال مجدد کار.' });
      }
    },
  );

  router.post(
    '/monitor/jobs/:id/cancel',
    requireRole('operator'),
    async (req: AdminRequest, res: Response) => {
      const jobId = String(req.params.id ?? '');
      try {
        const db = getDb();
        const [job] = await db
          .select()
          .from(generationJobs)
          .where(eq(generationJobs.id, jobId))
          .limit(1);
        if (!job) {
          res.status(404).json({ error: 'کار مورد نظر یافت نشد.' });
          return;
        }
        await refundFailedRequest({
          requestId: job.requestId,
          jobId: job.id,
          errorCode: 'ADMIN_CANCELED',
          errorMessage: 'لغو توسط مدیر سیستم',
          canceled: true,
        });
        res.json({ ok: true });
      } catch (err) {
        console.error('[monitor/jobs/cancel]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در لغو کار.' });
      }
    },
  );

  // =========================================================================
  // 6. PROVIDER PERFORMANCE & MODEL USAGE
  // =========================================================================
  router.get('/monitor/provider-performance', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [providers, stats] = await Promise.all([
        db.select().from(aiProviders).orderBy(aiProviders.priority),
        db
          .select({
            providerId: aiRequests.providerId,
            totalRequests: count(),
            succeededRequests: sql<number>`count(*) filter (where ${aiRequests.status} = 'succeeded')`,
            failedRequests: sql<number>`count(*) filter (where ${aiRequests.status} = 'failed')`,
            fallbackRequests: sql<number>`count(*) filter (where ${aiRequests.usedFallback} = true)`,
            avgLatencyMs: sql<number>`coalesce(round(avg(${aiRequests.latencyMs})), 0)`,
            totalCostUsd: sql<string>`coalesce(sum(${aiRequests.costUsd}), 0)`,
          })
          .from(aiRequests)
          .groupBy(aiRequests.providerId),
      ]);

      const statsMap = new Map(stats.map((s) => [s.providerId, s]));

      res.json({
        providers: providers.map((p) => {
          const st = statsMap.get(p.id);
          const total = Number(st?.totalRequests ?? 0);
          const succeeded = Number(st?.succeededRequests ?? 0);
          const failed = Number(st?.failedRequests ?? 0);
          const successRate = total > 0 ? Number(((succeeded / total) * 100).toFixed(1)) : 100;
          return {
            id: p.id,
            name: p.name,
            providerType: p.providerType,
            connectionStatus: p.connectionStatus,
            isActive: p.isActive,
            lastTestLatencyMs: p.lastTestLatencyMs,
            totalRequests: total,
            succeededRequests: succeeded,
            failedRequests: failed,
            fallbackRequests: Number(st?.fallbackRequests ?? 0),
            successRate,
            avgLatencyMs: Number(st?.avgLatencyMs ?? 0),
            totalCostUsd: Number(st?.totalCostUsd ?? 0),
          };
        }),
      });
    } catch (err) {
      console.error('[monitor/provider-perf]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت عملکرد ارائه‌دهندگان.' });
    }
  });

  router.get('/monitor/model-usage', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [models, stats] = await Promise.all([
        db
          .select({
            id: aiModels.id,
            name: aiModels.name,
            modelIdentifier: aiModels.modelIdentifier,
            category: aiModels.category,
            isActive: aiModels.isActive,
            creditCost: aiModels.creditCost,
            providerName: aiProviders.name,
          })
          .from(aiModels)
          .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
          .orderBy(aiModels.priority),
        db
          .select({
            modelId: aiRequests.modelId,
            totalRequests: count(),
            succeededRequests: sql<number>`count(*) filter (where ${aiRequests.status} = 'succeeded')`,
            failedRequests: sql<number>`count(*) filter (where ${aiRequests.status} = 'failed')`,
            avgLatencyMs: sql<number>`coalesce(round(avg(${aiRequests.latencyMs})), 0)`,
            totalCredits: sql<string>`coalesce(sum(${aiRequests.creditsCharged}), 0)`,
            totalCostUsd: sql<string>`coalesce(sum(${aiRequests.costUsd}), 0)`,
            inputTokens: sql<number>`coalesce(sum(${aiRequests.inputTokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${aiRequests.outputTokens}), 0)`,
          })
          .from(aiRequests)
          .groupBy(aiRequests.modelId),
      ]);

      const statsMap = new Map(stats.map((s) => [s.modelId, s]));

      res.json({
        models: models.map((m) => {
          const st = statsMap.get(m.id);
          const total = Number(st?.totalRequests ?? 0);
          const succeeded = Number(st?.succeededRequests ?? 0);
          return {
            ...m,
            creditCost: Number(m.creditCost),
            totalRequests: total,
            succeededRequests: succeeded,
            failedRequests: Number(st?.failedRequests ?? 0),
            successRate: total > 0 ? Number(((succeeded / total) * 100).toFixed(1)) : 100,
            avgLatencyMs: Number(st?.avgLatencyMs ?? 0),
            totalCredits: Number(st?.totalCredits ?? 0),
            totalCostUsd: Number(st?.totalCostUsd ?? 0),
            inputTokens: Number(st?.inputTokens ?? 0),
            outputTokens: Number(st?.outputTokens ?? 0),
          };
        }),
      });
    } catch (err) {
      console.error('[monitor/model-usage]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت آمار مصرف مدل‌ها.' });
    }
  });

  return router;
}
