import { Router, type Response } from 'express';
import { count, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { telegramBotSettings, webhookEvents } from '../../db/schema.ts';
import {
  decryptSecret,
  EncryptionKeyUnavailableError,
  encryptSecret,
  maskSecret,
} from '../security/crypto.ts';
import {
  generateWebhookSecret,
  getTelegramWebhookStatus,
  normalizeBotToken,
  normalizeWebhookUrl,
  syncTelegramWebhook,
  testTelegramBotConnection,
} from '../services/telegramService.ts';
import { recordAuditLog } from '../security/audit.ts';
import {
  getClientIp,
  requireAdminAuth,
  requireRole,
  type AdminRequest,
} from '../middleware/auth.ts';

function resolveHttpsOrigin(req: AdminRequest): string | null {
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

export function createTelegramAdminRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);

  // Required Phase 2 Endpoint: POST /api/telegram/set-webhook
  router.post(
    '/telegram/set-webhook',
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
          res.status(400).json({ error: 'برای ثبت وب‌هوک، آدرس HTTPS معتبر الزامی است.' });
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
        if (syncRes.ok && (row.connectionStatus !== 'connected' || !row.botUsername)) {
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

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'telegram.webhook_registered',
          resourceType: 'telegram_bot_settings',
          resourceId: row.id,
          severity: syncRes.ok ? 'info' : 'warning',
          status: syncRes.ok ? 'success' : 'failure',
          ipAddress: ip,
          userAgent: ua,
          details: { webhookUrl: requestedUrl, ok: syncRes.ok },
          extraSecretsToRedact: [botToken, webhookSecret ?? ''],
        });

        res.status(syncRes.ok ? 200 : 400).json(syncRes);
      } catch (err) {
        if (err instanceof EncryptionKeyUnavailableError) {
          res.status(503).json({ error: err.message, code: 'ENCRYPTION_KEY_MISSING' });
          return;
        }
        console.error('[telegram/set-webhook]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در ثبت وب‌هوک تلگرام.' });
      }
    },
  );

  // Required Phase 2 Endpoint: GET /api/telegram/webhook-status
  router.get('/telegram/webhook-status', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [[row], [eventsTotal], [failedTotal], recentEvents] = await Promise.all([
        db
          .select()
          .from(telegramBotSettings)
          .where(eq(telegramBotSettings.singletonKey, 'primary'))
          .limit(1),
        db.select({ total: count() }).from(webhookEvents).where(eq(webhookEvents.source, 'telegram')),
        db
          .select({ total: count() })
          .from(webhookEvents)
          .where(eq(webhookEvents.status, 'failed')),
        db
          .select({
            id: webhookEvents.id,
            externalEventId: webhookEvents.idempotencyKey,
            eventType: webhookEvents.eventType,
            status: webhookEvents.status,
            errorMessage: webhookEvents.errorMessage,
            receivedAt: webhookEvents.createdAt,
            processedAt: webhookEvents.processedAt,
          })
          .from(webhookEvents)
          .where(eq(webhookEvents.source, 'telegram'))
          .orderBy(desc(webhookEvents.createdAt))
          .limit(10),
      ]);

      let liveStatus = null;
      if (row?.encryptedBotToken && row.tokenIv && row.tokenAuthTag) {
        const botToken = decryptSecret({
          ciphertext: row.encryptedBotToken,
          iv: row.tokenIv,
          authTag: row.tokenAuthTag,
        });
        liveStatus = await getTelegramWebhookStatus(botToken);
      }

      res.json({
        configured: Boolean(row?.encryptedBotToken),
        hasWebhookSecret: Boolean(row?.encryptedWebhookSecret),
        isActive: Boolean(row?.isActive),
        botUsername: row?.botUsername ?? '',
        configuredWebhookUrl: row?.webhookUrl ?? '',
        connectionStatus: row?.connectionStatus ?? 'untested',
        liveStatus,
        stats: {
          totalEvents: eventsTotal?.total ?? 0,
          failedEvents: failedTotal?.total ?? 0,
        },
        recentEvents,
      });
    } catch (err) {
      if (err instanceof EncryptionKeyUnavailableError) {
        res.status(503).json({ error: err.message, code: 'ENCRYPTION_KEY_MISSING' });
        return;
      }
      console.error('[telegram/webhook-status]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در استعلام وضعیت وب‌هوک تلگرام.' });
    }
  });

  // Required Phase 2 Endpoint: POST /api/telegram/test-connection
  router.post(
    '/telegram/test-connection',
    requireRole('operator'),
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
          details: {
            ok: result.ok,
            latencyMs: result.latencyMs,
            unsavedToken: Boolean(candidateToken),
          },
          extraSecretsToRedact: [botToken],
        });

        res.json({ result });
      } catch (err) {
        if (err instanceof EncryptionKeyUnavailableError) {
          res.status(503).json({ error: err.message, code: 'ENCRYPTION_KEY_MISSING' });
          return;
        }
        console.error('[telegram/test-connection]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در تست اتصال ربات تلگرام.' });
      }
    },
  );

  return router;
}
