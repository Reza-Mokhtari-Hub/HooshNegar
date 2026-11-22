import { Router, type Response } from 'express';
import { count, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiProviders,
  aiRequests,
  coupons,
  creditTransactions,
  creditWallets,
  generationJobs,
  payments,
  referralCodes,
  referralRelationships,
  referralRewards,
  subscriptionPlans,
  systemSettings,
  telegramAccounts,
  telegramBotSettings,
  usageRecords,
  userProfiles,
  users,
  userSubscriptions,
} from '../../db/schema.ts';
import {
  couponCreateSchema,
  referralCodeCreateSchema,
  subscriptionPlanSchema,
  subscriptionPlanUpdateSchema,
  systemSettingsSchema,
  telegramSettingsUpdateSchema,
  userStatusUpdateSchema,
} from '../../shared/validation.ts';
import {
  decryptSecret,
  EncryptionKeyUnavailableError,
  encryptSecret,
  maskSecret,
} from '../security/crypto.ts';
import {
  generateWebhookSecret,
  isValidTelegramTokenFormat,
  normalizeBotToken,
  normalizeMiniAppUrl,
  normalizeWebhookUrl,
  syncTelegramChatMenuButton,
  syncTelegramWebhook,
  testTelegramBotConnection,
  type TelegramBotTestResult,
} from '../services/telegramService.ts';
import { recordAuditLog } from '../security/audit.ts';
import { getEnvValidationSummary } from '../config/env.ts';
import { getCloudflareRequestContext } from '../cloudflare/requestContext.ts';
import { DEFAULT_SYSTEM_SETTINGS } from '../services/bootstrap.ts';
import {
  getClientIp,
  requireAdminAuth,
  requireRole,
  type AdminRequest,
} from '../middleware/auth.ts';

function resolveHttpsOrigin(req: AdminRequest): string | null {
  const cfOrigin = getCloudflareRequestContext()?.requestOrigin?.trim();
  if (cfOrigin && cfOrigin.startsWith('https://')) {
    return cfOrigin;
  }
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && envUrl.startsWith('https://')) {
    try {
      return new URL(envUrl).origin;
    } catch {
      // fall through
    }
  }
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  const proto = forwardedProto || req.protocol;
  const host = (String(req.headers['x-forwarded-host'] ?? '').split(',')[0]?.trim()) || req.get('host');
  if (proto === 'https' && host) {
    return `https://${host}`;
  }
  return null;
}

function serializeTelegramSettings(row: typeof telegramBotSettings.$inferSelect) {
  return {
    id: row.id,
    hasBotToken: Boolean(row.encryptedBotToken),
    maskedBotToken: row.maskedBotToken,
    botUsername: row.botUsername,
    botDisplayName: row.botDisplayName,
    webhookUrl: row.webhookUrl,
    hasWebhookSecret: Boolean(row.encryptedWebhookSecret),
    maskedWebhookSecret: row.maskedWebhookSecret,
    isActive: row.isActive,
    welcomeMessage: row.welcomeMessage,
    defaultLanguage: row.defaultLanguage,
    supportUsername: row.supportUsername,
    defaultModelId: row.defaultModelId,
    errorMessages: row.errorMessages,
    connectionStatus: row.connectionStatus,
    lastTestedAt: row.lastTestedAt,
    lastTestMessage: row.lastTestMessage,
    updatedAt: row.updatedAt,
  };
}

export function createPlatformRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);

  // =========================================================================
  // 1. REAL DASHBOARD METRICS (Zero Fabricated Statistics)
  // =========================================================================
  router.get('/dashboard/metrics', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [
        [totalUsersRow],
        [activeUsersRow],
        [totalProvidersRow],
        [activeModelsRow],
        [totalRequestsRow],
        [activeSubsRow],
        providersList,
        recentUsersRows,
        recentTransactionsRows,
        dailyUsageRows,
        tgRows,
      ] = await Promise.all([
        db.select({ value: count() }).from(users),
        db.select({ value: count() }).from(users).where(eq(users.status, 'active')),
        db.select({ value: count() }).from(aiProviders),
        db.select({ value: count() }).from(aiModels).where(eq(aiModels.isActive, true)),
        db.select({ value: count() }).from(aiRequests),
        db
          .select({ value: count() })
          .from(userSubscriptions)
          .where(eq(userSubscriptions.status, 'active')),
        db
          .select({
            id: aiProviders.id,
            name: aiProviders.name,
            providerType: aiProviders.providerType,
            connectionStatus: aiProviders.connectionStatus,
            isActive: aiProviders.isActive,
            lastTestLatencyMs: aiProviders.lastTestLatencyMs,
            lastTestedAt: aiProviders.lastTestedAt,
          })
          .from(aiProviders)
          .orderBy(aiProviders.priority)
          .limit(8),
        db
          .select({
            id: users.id,
            email: users.email,
            status: users.status,
            locale: users.locale,
            createdAt: users.createdAt,
            displayName: userProfiles.displayName,
            telegramUsername: telegramAccounts.username,
          })
          .from(users)
          .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
          .leftJoin(telegramAccounts, eq(telegramAccounts.userId, users.id))
          .orderBy(desc(users.createdAt))
          .limit(6),
        db
          .select({
            id: payments.id,
            amount: payments.amount,
            currency: payments.currency,
            gateway: payments.gateway,
            status: payments.status,
            createdAt: payments.createdAt,
            userEmail: users.email,
          })
          .from(payments)
          .leftJoin(users, eq(payments.userId, users.id))
          .orderBy(desc(payments.createdAt))
          .limit(6),
        db
          .select({
            date: usageRecords.recordedDate,
            requests: count(),
            credits: sql<string>`coalesce(sum(${usageRecords.creditsConsumed}), 0)`,
          })
          .from(usageRecords)
          .groupBy(usageRecords.recordedDate)
          .orderBy(usageRecords.recordedDate)
          .limit(30),
        db
          .select({
            isActive: telegramBotSettings.isActive,
            connectionStatus: telegramBotSettings.connectionStatus,
            botUsername: telegramBotSettings.botUsername,
            maskedBotToken: telegramBotSettings.maskedBotToken,
          })
          .from(telegramBotSettings)
          .limit(1),
      ]);

      const env = getEnvValidationSummary();
      const tg = tgRows[0];

      res.json({
        kpis: {
          totalUsers: totalUsersRow?.value ?? 0,
          activeUsers: activeUsersRow?.value ?? 0,
          totalProviders: totalProvidersRow?.value ?? 0,
          activeModels: activeModelsRow?.value ?? 0,
          totalGenerationRequests: totalRequestsRow?.value ?? 0,
          activeSubscriptions: activeSubsRow?.value ?? 0,
        },
        usageSeries: dailyUsageRows.map((r) => ({
          date: r.date,
          requests: Number(r.requests),
          credits: Number(r.credits),
        })),
        providerStatuses: providersList,
        recentUsers: recentUsersRows,
        recentTransactions: recentTransactionsRows.map((t) => ({
          ...t,
          amount: Number(t.amount),
        })),
        systemHealth: {
          database: {
            ok: true,
            mode: env.databaseMode,
          },
          encryption: {
            ok: env.encryptionConfigured,
            source: env.encryptionSource,
          },
          telegramBot: {
            configured: Boolean(tg?.maskedBotToken),
            isActive: Boolean(tg?.isActive),
            connectionStatus: tg?.connectionStatus ?? 'untested',
            botUsername: tg?.botUsername ?? '',
          },
          warnings: env.warnings,
        },
      });
    } catch (err) {
      console.error('[dashboard/metrics]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در بارگذاری آمار داشبورد از پایگاه‌داده.' });
    }
  });

  // =========================================================================
  // 2. TELEGRAM BOT CONFIGURATION (Encrypted Token & Secret)
  // =========================================================================
  router.get('/telegram', async (req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [row] = await db
        .select()
        .from(telegramBotSettings)
        .where(eq(telegramBotSettings.singletonKey, 'primary'))
        .limit(1);

      if (!row) {
        res.status(404).json({ error: 'پیکربندی ربات تلگرام یافت نشد.' });
        return;
      }

      const httpsOrigin = resolveHttpsOrigin(req);
      const suggestedWebhookUrl = httpsOrigin ? `${httpsOrigin}/api/telegram/webhook` : '';
      const miniAppUrl =
        normalizeMiniAppUrl(row.webhookUrl) || (httpsOrigin ? `${httpsOrigin}/miniapp` : '');

      // Strictly omit encryptedBotToken, tokenIv, tokenAuthTag, encryptedWebhookSecret
      res.json({
        settings: serializeTelegramSettings(row),
        suggestedWebhookUrl,
        miniAppUrl,
      });
    } catch (err) {
      console.error('[telegram/get]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت تنظیمات ربات تلگرام.' });
    }
  });

  router.put('/telegram', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = telegramSettingsUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message ?? 'تنظیمات تلگرام نامعتبر است.',
          issues: parsed.error.issues,
        });
        return;
      }

      const data = parsed.data;
      const db = getDb();
      const now = new Date();
      const extraSecrets: string[] = [];

      const [existing] = await db
        .select()
        .from(telegramBotSettings)
        .where(eq(telegramBotSettings.singletonKey, 'primary'))
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: 'پیکربندی ربات تلگرام یافت نشد.' });
        return;
      }

      const normalizedToken = data.botToken ? normalizeBotToken(data.botToken) : '';
      if (normalizedToken && !isValidTelegramTokenFormat(normalizedToken)) {
        res.status(400).json({
          error:
            'فرمت توکن ربات تلگرام معتبر نیست. توکن باید بدون فاصله و شبیه 1234567890:AAF... باشد.',
        });
        return;
      }

      const httpsOrigin = resolveHttpsOrigin(req);
      const effectiveWebhookUrl = normalizeWebhookUrl(
        data.webhookUrl || existing.webhookUrl || '',
        httpsOrigin,
      );
      const isInitialTokenSetup = Boolean(normalizedToken && !existing.encryptedBotToken);
      const effectiveIsActive = isInitialTokenSetup ? true : data.isActive;

      const updateValues: Partial<typeof telegramBotSettings.$inferInsert> = {
        botUsername: data.botUsername.replace(/^@/, ''),
        botDisplayName: data.botDisplayName,
        webhookUrl: effectiveWebhookUrl,
        isActive: effectiveIsActive,
        welcomeMessage: data.welcomeMessage,
        defaultLanguage: data.defaultLanguage,
        supportUsername: data.supportUsername.replace(/^@/, ''),
        defaultModelId: data.defaultModelId ?? null,
        errorMessages: data.errorMessages,
        updatedAt: now,
      };

      let effectiveBotToken: string | null = null;
      if (normalizedToken) {
        const enc = encryptSecret(normalizedToken);
        updateValues.encryptedBotToken = enc.ciphertext;
        updateValues.tokenIv = enc.iv;
        updateValues.tokenAuthTag = enc.authTag;
        updateValues.maskedBotToken = maskSecret(normalizedToken);
        updateValues.connectionStatus = 'untested';
        effectiveBotToken = normalizedToken;
        extraSecrets.push(normalizedToken);
      } else if (existing.encryptedBotToken && existing.tokenIv && existing.tokenAuthTag) {
        effectiveBotToken = decryptSecret({
          ciphertext: existing.encryptedBotToken,
          iv: existing.tokenIv,
          authTag: existing.tokenAuthTag,
        });
        extraSecrets.push(effectiveBotToken);
      }

      let effectiveWebhookSecret: string | null = null;
      const providedSecret = data.webhookSecret?.trim() ?? '';
      if (providedSecret.length > 0) {
        const encSecret = encryptSecret(providedSecret);
        updateValues.encryptedWebhookSecret = encSecret.ciphertext;
        updateValues.webhookSecretIv = encSecret.iv;
        updateValues.webhookSecretAuthTag = encSecret.authTag;
        updateValues.maskedWebhookSecret = maskSecret(providedSecret);
        effectiveWebhookSecret = providedSecret;
        extraSecrets.push(providedSecret);
      } else if (
        existing.encryptedWebhookSecret &&
        existing.webhookSecretIv &&
        existing.webhookSecretAuthTag
      ) {
        effectiveWebhookSecret = decryptSecret({
          ciphertext: existing.encryptedWebhookSecret,
          iv: existing.webhookSecretIv,
          authTag: existing.webhookSecretAuthTag,
        });
        extraSecrets.push(effectiveWebhookSecret);
      } else {
        // Auto-provision a strong CSPRNG webhook secret so /api/telegram/webhook never fails with 401
        const autoSecret = generateWebhookSecret();
        const encAuto = encryptSecret(autoSecret);
        updateValues.encryptedWebhookSecret = encAuto.ciphertext;
        updateValues.webhookSecretIv = encAuto.iv;
        updateValues.webhookSecretAuthTag = encAuto.authTag;
        updateValues.maskedWebhookSecret = maskSecret(autoSecret);
        effectiveWebhookSecret = autoSecret;
        extraSecrets.push(autoSecret);
      }

      let [updated] = await db
        .update(telegramBotSettings)
        .set(updateValues)
        .where(eq(telegramBotSettings.singletonKey, 'primary'))
        .returning();

      let connectionResult: TelegramBotTestResult | null = null;
      let webhookSyncResult: { ok: boolean; message: string } | null = null;
      let menuButtonSyncResult: { ok: boolean; message: string } | null = null;
      const miniAppUrl =
        normalizeMiniAppUrl(effectiveWebhookUrl) || (httpsOrigin ? `${httpsOrigin}/miniapp` : '');

      if (updated && effectiveBotToken) {
        connectionResult = await testTelegramBotConnection(effectiveBotToken);
        let statusMessage = connectionResult.message;

        if (
          connectionResult.ok &&
          effectiveIsActive &&
          effectiveWebhookUrl &&
          effectiveWebhookUrl.startsWith('https://')
        ) {
          webhookSyncResult = await syncTelegramWebhook(
            effectiveBotToken,
            effectiveWebhookUrl,
            effectiveWebhookSecret,
          );
          if (!webhookSyncResult.ok) {
            statusMessage = `${connectionResult.message} — خطای ثبت وب‌هوک: ${webhookSyncResult.message}`;
          } else if (miniAppUrl) {
            menuButtonSyncResult = await syncTelegramChatMenuButton(effectiveBotToken, miniAppUrl);
          }
        }

        const [afterConnect] = await db
          .update(telegramBotSettings)
          .set({
            connectionStatus: connectionResult.status,
            lastTestedAt: new Date(),
            lastTestMessage: statusMessage,
            botUsername: connectionResult.botInfo?.username || updated.botUsername,
            botDisplayName: connectionResult.botInfo?.firstName || updated.botDisplayName,
            updatedAt: new Date(),
          })
          .where(eq(telegramBotSettings.id, updated.id))
          .returning();

        if (afterConnect) {
          updated = afterConnect;
        }
      }

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'telegram.settings_updated',
        resourceType: 'telegram_bot_settings',
        resourceId: updated?.id,
        severity: extraSecrets.length > 0 ? 'warning' : 'info',
        ipAddress: ip,
        userAgent: ua,
        details: {
          botUsername: updated?.botUsername,
          isActive: updated?.isActive,
          tokenRotated: Boolean(normalizedToken),
          webhookSecretUpdated: Boolean(providedSecret),
          connectionOk: connectionResult?.ok ?? null,
          webhookSyncOk: webhookSyncResult?.ok ?? null,
          menuButtonSyncOk: menuButtonSyncResult?.ok ?? null,
        },
        extraSecretsToRedact: extraSecrets,
      });

      res.json({
        ok: true,
        settings: updated ? serializeTelegramSettings(updated) : null,
        miniAppUrl,
        connectionResult,
        webhookSyncResult,
        menuButtonSyncResult,
      });
    } catch (err) {
      if (err instanceof EncryptionKeyUnavailableError) {
        res.status(503).json({ error: err.message, code: 'ENCRYPTION_KEY_MISSING' });
        return;
      }
      console.error('[telegram/put]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در ذخیره تنظیمات ربات تلگرام.' });
    }
  });

  router.post('/telegram/test', requireRole('operator'), async (req: AdminRequest, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const db = getDb();
      const [row] = await db
        .select()
        .from(telegramBotSettings)
        .where(eq(telegramBotSettings.singletonKey, 'primary'))
        .limit(1);

      const candidateToken =
        typeof req.body?.botToken === 'string' && req.body.botToken.trim().length > 0
          ? normalizeBotToken(req.body.botToken)
          : null;

      if (!candidateToken && (!row?.encryptedBotToken || !row.tokenIv || !row.tokenAuthTag)) {
        res.status(400).json({
          error: 'توکن ربات تلگرام هنوز تنظیم نشده است. ابتدا توکن را وارد کنید.',
          code: 'BOT_TOKEN_NOT_CONFIGURED',
        });
        return;
      }

      const botToken =
        candidateToken ??
        decryptSecret({
          ciphertext: row!.encryptedBotToken!,
          iv: row!.tokenIv!,
          authTag: row!.tokenAuthTag!,
        });

      const result = await testTelegramBotConnection(botToken);
      const now = new Date();

      if (row && !candidateToken) {
        await db
          .update(telegramBotSettings)
          .set({
            connectionStatus: result.status,
            lastTestedAt: now,
            lastTestMessage: result.message,
            botUsername: result.botInfo?.username || row.botUsername,
            botDisplayName: result.botInfo?.firstName || row.botDisplayName,
            updatedAt: now,
          })
          .where(eq(telegramBotSettings.id, row.id));
      }

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'telegram.connection_tested',
        resourceType: 'telegram_bot_settings',
        resourceId: row?.id,
        severity: result.ok ? 'info' : 'warning',
        status: result.ok ? 'success' : 'failure',
        ipAddress: ip,
        userAgent: ua,
        details: { ok: result.ok, latencyMs: result.latencyMs, unsavedToken: Boolean(candidateToken) },
        extraSecretsToRedact: [botToken],
      });

      res.json({ result });
    } catch (err) {
      if (err instanceof EncryptionKeyUnavailableError) {
        res.status(503).json({ error: err.message, code: 'ENCRYPTION_KEY_MISSING' });
        return;
      }
      console.error('[telegram/test]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در تست اتصال ربات تلگرام.' });
    }
  });

  router.post(
    '/telegram/webhook/sync',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const db = getDb();
        const [row] = await db
          .select()
          .from(telegramBotSettings)
          .where(eq(telegramBotSettings.singletonKey, 'primary'))
          .limit(1);

        if (!row?.encryptedBotToken || !row.tokenIv || !row.tokenAuthTag) {
          res.status(400).json({ error: 'توکن ربات تلگرام پیکربندی نشده است.' });
          return;
        }

        const requestedUrl = normalizeWebhookUrl(
          typeof req.body?.webhookUrl === 'string' && req.body.webhookUrl.trim()
            ? req.body.webhookUrl
            : row.webhookUrl,
          resolveHttpsOrigin(req),
        );

        if (!requestedUrl || !requestedUrl.startsWith('https://')) {
          res.status(400).json({ error: 'ابتدا آدرس HTTPS معتبر برای وب‌هوک ذخیره کنید.' });
          return;
        }

        const botToken = decryptSecret({
          ciphertext: row.encryptedBotToken,
          iv: row.tokenIv,
          authTag: row.tokenAuthTag,
        });

        let webhookSecret =
          row.encryptedWebhookSecret && row.webhookSecretIv && row.webhookSecretAuthTag
            ? decryptSecret({
                ciphertext: row.encryptedWebhookSecret,
                iv: row.webhookSecretIv,
                authTag: row.webhookSecretAuthTag,
              })
            : null;

        const patch: Partial<typeof telegramBotSettings.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (requestedUrl !== row.webhookUrl) {
          patch.webhookUrl = requestedUrl;
        }
        if (!webhookSecret) {
          webhookSecret = generateWebhookSecret();
          const encAuto = encryptSecret(webhookSecret);
          patch.encryptedWebhookSecret = encAuto.ciphertext;
          patch.webhookSecretIv = encAuto.iv;
          patch.webhookSecretAuthTag = encAuto.authTag;
          patch.maskedWebhookSecret = maskSecret(webhookSecret);
        }
        if (!row.isActive) {
          patch.isActive = true;
        }
        await db.update(telegramBotSettings).set(patch).where(eq(telegramBotSettings.id, row.id));

        const syncRes = await syncTelegramWebhook(botToken, requestedUrl, webhookSecret);
        const miniAppUrl = normalizeMiniAppUrl(requestedUrl);
        let menuButtonRes: { ok: boolean; message: string } | null = null;
        if (syncRes.ok) {
          if (miniAppUrl) {
            menuButtonRes = await syncTelegramChatMenuButton(botToken, miniAppUrl);
          }
          if (row.connectionStatus !== 'connected') {
            const testRes = await testTelegramBotConnection(botToken);
            await db
              .update(telegramBotSettings)
              .set({
                connectionStatus: testRes.status,
                lastTestedAt: new Date(),
                lastTestMessage: testRes.message,
                botUsername: testRes.botInfo?.username || row.botUsername,
                botDisplayName: testRes.botInfo?.firstName || row.botDisplayName,
                updatedAt: new Date(),
              })
              .where(eq(telegramBotSettings.id, row.id));
          }
        }

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'telegram.webhook_synced',
          resourceType: 'telegram_bot_settings',
          resourceId: row.id,
          severity: syncRes.ok ? 'info' : 'warning',
          status: syncRes.ok ? 'success' : 'failure',
          ipAddress: ip,
          userAgent: ua,
          details: { webhookUrl: requestedUrl, miniAppUrl, ok: syncRes.ok, menuButtonOk: menuButtonRes?.ok ?? null },
          extraSecretsToRedact: [botToken, webhookSecret ?? ''],
        });

        res.status(syncRes.ok ? 200 : 400).json({
          ...syncRes,
          miniAppUrl,
          menuButtonSyncResult: menuButtonRes,
        });
      } catch (err) {
        console.error('[telegram/webhook/sync]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در همگام‌سازی وب‌هوک تلگرام.' });
      }
    },
  );

  // =========================================================================
  // 3. SUBSCRIPTION PLANS CRUD
  // =========================================================================
  router.get('/plans', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const plans = await db
        .select()
        .from(subscriptionPlans)
        .orderBy(subscriptionPlans.sortOrder, desc(subscriptionPlans.createdAt));

      res.json({
        plans: plans.map((p) => ({
          ...p,
          priceAmount: Number(p.priceAmount),
        })),
      });
    } catch (err) {
      console.error('[plans/list]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت پلن‌های اشتراک.' });
    }
  });

  router.post('/plans', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = subscriptionPlanSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message ?? 'اطلاعات پلن نامعتبر است.',
          issues: parsed.error.issues,
        });
        return;
      }

      const d = parsed.data;
      const db = getDb();
      const [created] = await db
        .insert(subscriptionPlans)
        .values({
          ...d,
          priceAmount: String(d.priceAmount),
        })
        .returning();

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'plan.created',
        resourceType: 'subscription_plan',
        resourceId: created?.id,
        ipAddress: ip,
        userAgent: ua,
        details: { name: d.name, tier: d.tier, priceAmount: d.priceAmount, currency: d.currency },
      });

      res.status(201).json({ plan: created ? { ...created, priceAmount: Number(created.priceAmount) } : null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        res.status(409).json({ error: 'پلنی با این اسلاگ قبلاً ثبت شده است.' });
        return;
      }
      console.error('[plans/create]', msg);
      res.status(500).json({ error: 'خطا در ایجاد پلن اشتراک.' });
    }
  });

  router.patch('/plans/:id', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = subscriptionPlanUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'اطلاعات نامعتبر است.' });
        return;
      }
      const d = parsed.data;
      const db = getDb();
      const [updated] = await db
        .update(subscriptionPlans)
        .set({
          ...d,
          priceAmount: d.priceAmount !== undefined ? String(d.priceAmount) : undefined,
          updatedAt: new Date(),
        })
        .where(eq(subscriptionPlans.id, id))
        .returning();

      if (!updated) {
        res.status(404).json({ error: 'پلن مورد نظر یافت نشد.' });
        return;
      }

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'plan.updated',
        resourceType: 'subscription_plan',
        resourceId: updated.id,
        ipAddress: ip,
        userAgent: ua,
        details: { name: updated.name, isEnabled: updated.isEnabled },
      });

      res.json({ plan: { ...updated, priceAmount: Number(updated.priceAmount) } });
    } catch (err) {
      console.error('[plans/update]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در به‌روزرسانی پلن.' });
    }
  });

  router.delete('/plans/:id', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const db = getDb();
      const [deleted] = await db
        .delete(subscriptionPlans)
        .where(eq(subscriptionPlans.id, id))
        .returning({ id: subscriptionPlans.id, name: subscriptionPlans.name });

      if (!deleted) {
        res.status(404).json({ error: 'پلن مورد نظر یافت نشد.' });
        return;
      }

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'plan.deleted',
        resourceType: 'subscription_plan',
        resourceId: deleted.id,
        severity: 'warning',
        ipAddress: ip,
        userAgent: ua,
        details: { name: deleted.name },
      });

      res.json({ ok: true });
    } catch (err) {
      console.error('[plans/delete]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'امکان حذف پلن دارای اشتراک فعال وجود ندارد.' });
    }
  });

  // =========================================================================
  // 4. SYSTEM SETTINGS
  // =========================================================================
  router.get('/settings', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.isSecret, false));

      const map: Record<string, unknown> = { ...DEFAULT_SYSTEM_SETTINGS };
      for (const row of rows) {
        map[row.settingKey] = row.value;
      }

      res.json({ settings: map });
    } catch (err) {
      console.error('[settings/get]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت تنظیمات سیستم.' });
    }
  });

  router.put('/settings', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = systemSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message ?? 'تنظیمات سیستم نامعتبر است.',
          issues: parsed.error.issues,
        });
        return;
      }

      const db = getDb();
      const now = new Date();
      const entries = Object.entries(parsed.data);

      await db.transaction(async (tx) => {
        for (const [settingKey, rawValue] of entries) {
          const safeValue = rawValue === null || rawValue === undefined ? '' : rawValue;
          await tx
            .insert(systemSettings)
            .values({
              settingKey,
              value: safeValue,
              category: 'general',
              isSecret: false,
              updatedByAdminId: req.admin!.id,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: systemSettings.settingKey,
              set: {
                value: safeValue,
                updatedByAdminId: req.admin!.id,
                updatedAt: now,
              },
            });
        }
      });

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'system.settings_updated',
        resourceType: 'system_settings',
        severity: parsed.data.maintenanceMode ? 'warning' : 'info',
        ipAddress: ip,
        userAgent: ua,
        details: {
          appName: parsed.data.appName,
          maintenanceMode: parsed.data.maintenanceMode,
          defaultLanguage: parsed.data.defaultLanguage,
        },
      });

      res.json({ ok: true, settings: parsed.data });
    } catch (err) {
      console.error('[settings/put]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در ذخیره تنظیمات سیستم.' });
    }
  });

  // =========================================================================
  // 5. USERS, TRANSACTIONS, REFERRALS & USAGE ANALYTICS (Real DB Queries)
  // =========================================================================
  router.get('/users', async (req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const q = String(req.query.q ?? '').trim().toLowerCase();
      const statusFilter = String(req.query.status ?? '').trim();

      const [rows, activeSubs] = await Promise.all([
        db
          .select({
            id: users.id,
            email: users.email,
            phoneNumber: users.phoneNumber,
            status: users.status,
            locale: users.locale,
            lastActiveAt: users.lastActiveAt,
            createdAt: users.createdAt,
            displayName: userProfiles.displayName,
            telegramUserId: telegramAccounts.telegramUserId,
            telegramUsername: telegramAccounts.username,
            walletBalance: creditWallets.balance,
          })
          .from(users)
          .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
          .leftJoin(telegramAccounts, eq(telegramAccounts.userId, users.id))
          .leftJoin(creditWallets, eq(creditWallets.userId, users.id))
          .orderBy(desc(users.createdAt))
          .limit(200),
        db
          .select({
            userId: userSubscriptions.userId,
            planName: subscriptionPlans.name,
            planTier: subscriptionPlans.tier,
            endsAt: userSubscriptions.endsAt,
            status: userSubscriptions.status,
          })
          .from(userSubscriptions)
          .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
          .where(eq(userSubscriptions.status, 'active'))
          .orderBy(desc(userSubscriptions.endsAt)),
      ]);

      const subByUser = new Map<string, { planName: string; planTier: string; endsAt: Date }>();
      for (const s of activeSubs) {
        if (!subByUser.has(s.userId)) {
          subByUser.set(s.userId, { planName: s.planName, planTier: s.planTier, endsAt: s.endsAt });
        }
      }

      const enriched = rows
        .map((u) => {
          const sub = subByUser.get(u.id);
          return {
            ...u,
            walletBalance: Number(u.walletBalance ?? 0),
            activePlanName: sub?.planName ?? null,
            activePlanTier: sub?.planTier ?? null,
            subscriptionEndsAt: sub?.endsAt ?? null,
          };
        })
        .filter((u) => {
          if (statusFilter && statusFilter !== 'all' && u.status !== statusFilter) return false;
          if (!q) return true;
          const hay = [
            u.displayName,
            u.email,
            u.telegramUsername,
            u.telegramUserId ? String(u.telegramUserId) : '',
            u.activePlanName,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        });

      res.json({ users: enriched });
    } catch (err) {
      console.error('[users/list]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت فهرست کاربران.' });
    }
  });

  router.patch('/users/:id/status', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = userStatusUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'وضعیت کاربر نامعتبر است.' });
        return;
      }
      const db = getDb();
      const [updated] = await db
        .update(users)
        .set({ status: parsed.data.status, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning({ id: users.id, status: users.status });

      if (!updated) {
        res.status(404).json({ error: 'کاربر یافت نشد.' });
        return;
      }

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'user.status_changed',
        resourceType: 'user',
        resourceId: id,
        severity: 'warning',
        ipAddress: ip,
        userAgent: ua,
        details: { status: parsed.data.status },
      });

      res.json({ user: updated });
    } catch (err) {
      console.error('[users/status]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در تغییر وضعیت کاربر.' });
    }
  });

  router.get('/transactions', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [paymentRows, creditRows] = await Promise.all([
        db
          .select({
            id: payments.id,
            userId: payments.userId,
            userEmail: users.email,
            planName: subscriptionPlans.name,
            gateway: payments.gateway,
            gatewayRefId: payments.gatewayRefId,
            amount: payments.amount,
            currency: payments.currency,
            status: payments.status,
            idempotencyKey: payments.idempotencyKey,
            paidAt: payments.paidAt,
            createdAt: payments.createdAt,
          })
          .from(payments)
          .leftJoin(users, eq(payments.userId, users.id))
          .leftJoin(subscriptionPlans, eq(payments.planId, subscriptionPlans.id))
          .orderBy(desc(payments.createdAt))
          .limit(100),
        db
          .select({
            id: creditTransactions.id,
            userId: creditTransactions.userId,
            userEmail: users.email,
            type: creditTransactions.type,
            amount: creditTransactions.amount,
            balanceAfter: creditTransactions.balanceAfter,
            idempotencyKey: creditTransactions.idempotencyKey,
            description: creditTransactions.description,
            createdAt: creditTransactions.createdAt,
          })
          .from(creditTransactions)
          .leftJoin(users, eq(creditTransactions.userId, users.id))
          .orderBy(desc(creditTransactions.createdAt))
          .limit(100),
      ]);

      res.json({
        payments: paymentRows.map((p) => ({ ...p, amount: Number(p.amount) })),
        creditTransactions: creditRows.map((c) => ({
          ...c,
          amount: Number(c.amount),
          balanceAfter: Number(c.balanceAfter),
        })),
      });
    } catch (err) {
      console.error('[transactions/list]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت تاریخچه تراکنش‌ها.' });
    }
  });

  router.get('/referrals', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [codes, relationships, rewards, couponRows] = await Promise.all([
        db.select().from(referralCodes).orderBy(desc(referralCodes.createdAt)).limit(100),
        db.select().from(referralRelationships).orderBy(desc(referralRelationships.createdAt)).limit(50),
        db.select().from(referralRewards).orderBy(desc(referralRewards.createdAt)).limit(50),
        db.select().from(coupons).orderBy(desc(coupons.createdAt)).limit(100),
      ]);

      res.json({
        referralCodes: codes,
        relationships,
        rewards,
        coupons: couponRows.map((c) => ({ ...c, discountValue: Number(c.discountValue) })),
      });
    } catch (err) {
      console.error('[referrals/list]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت اطلاعات معرفی و کوپن‌ها.' });
    }
  });

  router.post('/referrals/codes', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = referralCodeCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'کد معرفی نامعتبر است.' });
        return;
      }
      const db = getDb();
      const [created] = await db
        .insert(referralCodes)
        .values({
          code: parsed.data.code.toUpperCase(),
          rewardCredits: parsed.data.rewardCredits,
          maxUses: parsed.data.maxUses ?? null,
          isActive: parsed.data.isActive,
        })
        .returning();

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'referral_code.created',
        resourceType: 'referral_code',
        resourceId: created?.id,
        ipAddress: ip,
        userAgent: ua,
        details: { code: created?.code, rewardCredits: created?.rewardCredits },
      });

      res.status(201).json({ referralCode: created });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        res.status(409).json({ error: 'این کد معرفی قبلاً ثبت شده است.' });
        return;
      }
      res.status(500).json({ error: 'خطا در ایجاد کد معرفی.' });
    }
  });

  router.post('/coupons', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = couponCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'کد تخفیف نامعتبر است.' });
        return;
      }
      const db = getDb();
      const [created] = await db
        .insert(coupons)
        .values({
          code: parsed.data.code.toUpperCase(),
          discountType: parsed.data.discountType,
          discountValue: String(parsed.data.discountValue),
          maxRedemptions: parsed.data.maxRedemptions ?? null,
          perUserLimit: parsed.data.perUserLimit ?? 1,
          minStarsAmount: parsed.data.minStarsAmount ?? 0,
          applicablePlanIds: parsed.data.applicablePlanIds ?? [],
          startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : null,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
          isActive: parsed.data.isActive,
        })
        .returning();

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'coupon.created',
        resourceType: 'coupon',
        resourceId: created?.id,
        ipAddress: ip,
        userAgent: ua,
        details: { code: created?.code, discountType: created?.discountType },
      });

      res.status(201).json({
        coupon: created ? { ...created, discountValue: Number(created.discountValue) } : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        res.status(409).json({ error: 'این کد تخفیف قبلاً ثبت شده است.' });
        return;
      }
      res.status(500).json({ error: 'خطا در ایجاد کد تخفیف.' });
    }
  });

  router.get('/analytics', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [byCapability, byDate, recentJobs, [totals]] = await Promise.all([
        db
          .select({
            capability: usageRecords.capability,
            requests: count(),
            credits: sql<string>`coalesce(sum(${usageRecords.creditsConsumed}), 0)`,
            costUsd: sql<string>`coalesce(sum(${usageRecords.costUsd}), 0)`,
          })
          .from(usageRecords)
          .groupBy(usageRecords.capability),
        db
          .select({
            date: usageRecords.recordedDate,
            requests: count(),
            credits: sql<string>`coalesce(sum(${usageRecords.creditsConsumed}), 0)`,
            costUsd: sql<string>`coalesce(sum(${usageRecords.costUsd}), 0)`,
          })
          .from(usageRecords)
          .groupBy(usageRecords.recordedDate)
          .orderBy(usageRecords.recordedDate)
          .limit(30),
        db
          .select({
            id: generationJobs.id,
            capability: generationJobs.capability,
            status: generationJobs.status,
            progressPercent: generationJobs.progressPercent,
            createdAt: generationJobs.createdAt,
            finishedAt: generationJobs.finishedAt,
          })
          .from(generationJobs)
          .orderBy(desc(generationJobs.createdAt))
          .limit(20),
        db
          .select({
            totalRequests: count(),
            totalInputTokens: sql<string>`coalesce(sum(${aiRequests.inputTokens}), 0)`,
            totalOutputTokens: sql<string>`coalesce(sum(${aiRequests.outputTokens}), 0)`,
            totalCredits: sql<string>`coalesce(sum(${aiRequests.creditsCharged}), 0)`,
            totalCostUsd: sql<string>`coalesce(sum(${aiRequests.costUsd}), 0)`,
          })
          .from(aiRequests),
      ]);

      res.json({
        summary: {
          totalRequests: Number(totals?.totalRequests ?? 0),
          totalInputTokens: Number(totals?.totalInputTokens ?? 0),
          totalOutputTokens: Number(totals?.totalOutputTokens ?? 0),
          totalCredits: Number(totals?.totalCredits ?? 0),
          totalCostUsd: Number(totals?.totalCostUsd ?? 0),
        },
        byCapability: byCapability.map((r) => ({
          capability: r.capability,
          requests: Number(r.requests),
          credits: Number(r.credits),
          costUsd: Number(r.costUsd),
        })),
        byDate: byDate.map((r) => ({
          date: r.date,
          requests: Number(r.requests),
          credits: Number(r.credits),
          costUsd: Number(r.costUsd),
        })),
        recentJobs,
      });
    } catch (err) {
      console.error('[analytics/get]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت تحلیل مصرف.' });
    }
  });

  return router;
}
