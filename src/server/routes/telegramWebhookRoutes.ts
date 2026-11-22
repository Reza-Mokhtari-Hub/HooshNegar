import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Update } from 'grammy/types';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { telegramBotSettings, webhookEvents } from '../../db/schema.ts';
import { decryptSecret, redactSecrets } from '../security/crypto.ts';
import {
  enqueueBackgroundJob,
  registerLocalJobProcessor,
  verifyQStashSignature,
  type QueuedJobPayload,
} from '../queue/qstash.ts';
import { processTelegramUpdate } from '../telegram/bot.ts';
import {
  executeQueuedGenerationJob,
  executeVideoPollJob,
} from '../telegram/jobRunner.ts';
import { refundFailedRequest } from '../services/usageService.ts';

import { getConfiguredTelegramApi } from '../telegram/jobRunner.ts';
import { validateTelegramPreCheckout } from '../services/telegramStarsService.ts';
import { runScheduledMaintenance } from '../services/maintenanceService.ts';

export interface RawBodyRequest extends Request {
  rawBody?: string;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function dispatchJobPayload(payload: QueuedJobPayload): Promise<void> {
  const db = getDb();

  if (payload.kind === 'telegram_update' && payload.update) {
    const updateId = (payload.update as { update_id?: number }).update_id;
    const extId = updateId !== undefined ? `tg_update:${updateId}` : null;
    try {
      await processTelegramUpdate(payload.update as unknown as Update);
      if (extId) {
        await db
          .update(webhookEvents)
          .set({ status: 'processed', processedAt: new Date() })
          .where(eq(webhookEvents.idempotencyKey, extId));
      }
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : 'Update processing failed');
      if (extId) {
        await db
          .update(webhookEvents)
          .set({ status: 'failed', errorMessage: msg.slice(0, 500) })
          .where(eq(webhookEvents.idempotencyKey, extId));
      }
      throw err;
    }
    return;
  }

  if (payload.kind === 'ai_generation_job' && payload.jobId) {
    await executeQueuedGenerationJob(payload.jobId);
    return;
  }

  if (payload.kind === 'video_poll_job' && payload.jobId) {
    await executeVideoPollJob(payload.jobId);
  }
}

export function initBackgroundJobProcessor(): void {
  registerLocalJobProcessor(dispatchJobPayload);
}

function getFullRequestUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'localhost:3000';
  return `${proto}://${host}${req.originalUrl}`;
}

export function createTelegramWebhookRouter(): Router {
  const router = Router();

  // =========================================================================
  // 1. TELEGRAM WEBHOOK RECEIVER (Secret-Token Validated + Idempotent + Fast ACK)
  // =========================================================================
  router.post('/telegram/webhook', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const [settings] = await db
        .select()
        .from(telegramBotSettings)
        .where(eq(telegramBotSettings.singletonKey, 'primary'))
        .limit(1);

      if (!settings) {
        res.status(503).json({ ok: false, error: 'Bot settings not initialized' });
        return;
      }

      // Require configured webhook secret & validate X-Telegram-Bot-Api-Secret-Token
      if (
        !settings.encryptedWebhookSecret ||
        !settings.webhookSecretIv ||
        !settings.webhookSecretAuthTag
      ) {
        res.status(401).json({ ok: false, error: 'Webhook secret token not configured' });
        return;
      }

      const headerToken = String(req.headers['x-telegram-bot-api-secret-token'] ?? '').trim();
      if (!headerToken) {
        res.status(401).json({ ok: false, error: 'Missing Telegram secret token header' });
        return;
      }

      const expectedSecret = decryptSecret({
        ciphertext: settings.encryptedWebhookSecret,
        iv: settings.webhookSecretIv,
        authTag: settings.webhookSecretAuthTag,
      });

      if (!constantTimeStringEqual(headerToken, expectedSecret)) {
        res.status(401).json({ ok: false, error: 'Invalid Telegram secret token' });
        return;
      }

      const update = req.body as Record<string, unknown> | null;
      const updateId = typeof update?.update_id === 'number' ? update.update_id : null;
      if (!update || updateId === null) {
        res.status(400).json({ ok: false, error: 'Invalid Telegram update payload' });
        return;
      }

      const externalEventId = `tg_update:${updateId}`;
      const eventType = update.message
        ? 'message'
        : update.callback_query
          ? 'callback_query'
          : update.pre_checkout_query
            ? 'pre_checkout_query'
            : 'other';

      // Atomic idempotency check via unique idempotencyKey
      const inserted = await db
        .insert(webhookEvents)
        .values({
          source: 'telegram',
          idempotencyKey: externalEventId,
          eventType,
          status: 'received',
          payload: {
            update_id: updateId,
            eventType,
            signatureVerified: true,
          },
        })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });

      if (inserted.length === 0) {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }

      // FAST SYNCHRONOUS PATH FOR pre_checkout_query (Telegram requires answer within 10 seconds!)
      if (update.pre_checkout_query && typeof update.pre_checkout_query === 'object') {
        const pcq = update.pre_checkout_query as {
          id: string;
          from: { id: number };
          currency: string;
          total_amount: number;
          invoice_payload: string;
        };

        const check = await validateTelegramPreCheckout({
          preCheckoutQueryId: pcq.id,
          telegramUserId: pcq.from.id,
          currency: pcq.currency,
          totalAmount: pcq.total_amount,
          invoicePayload: pcq.invoice_payload,
        });

        const tgClient = await getConfiguredTelegramApi();
        if (tgClient) {
          try {
            await tgClient.api.answerPreCheckoutQuery(pcq.id, check.ok, {
              error_message: check.ok ? undefined : check.errorMessage,
            });
          } catch (err) {
            console.error('[pre_checkout_answer]', redactSecrets(err instanceof Error ? err.message : 'err'));
          }
        }

        await db
          .update(webhookEvents)
          .set({ status: 'processed', processedAt: new Date() })
          .where(eq(webhookEvents.idempotencyKey, externalEventId));

        res.status(200).json({
          ok: true,
          preCheckoutApproved: check.ok,
          updateId,
        });
        return;
      }

      // Enqueue all other updates asynchronously and ACK Telegram immediately
      const enqueued = await enqueueBackgroundJob(
        {
          kind: 'telegram_update',
          idempotencyKey: externalEventId,
          update,
        },
        { retries: 3 },
      );

      res.status(200).json({
        ok: true,
        queued: true,
        mode: enqueued.mode,
        updateId,
      });
    } catch (err) {
      console.error(
        '[telegram/webhook]',
        redactSecrets(err instanceof Error ? err.message : 'unknown'),
      );
      res.status(500).json({ ok: false, error: 'Webhook processing error' });
    }
  });

  // =========================================================================
  // 1B. SCHEDULED MAINTENANCE CRON (Vercel Cron Bearer Secret OR QStash Signature)
  // =========================================================================
  const handleMaintenanceCron = async (req: RawBodyRequest, res: Response) => {
    const cronSecret = process.env.CRON_SECRET?.trim();
    const authHeader = String(req.headers.authorization ?? '');
    const bearerOk =
      Boolean(cronSecret) &&
      authHeader.startsWith('Bearer ') &&
      constantTimeStringEqual(authHeader.slice(7).trim(), cronSecret!);

    if (!bearerOk) {
      const signature = req.headers['upstash-signature'];
      const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
      const qstashCheck = await verifyQStashSignature({
        signature: typeof signature === 'string' ? signature : undefined,
        rawBody,
        url: getFullRequestUrl(req),
      });
      if (!qstashCheck.ok) {
        res.status(401).json({ ok: false, error: 'Unauthorized maintenance cron request' });
        return;
      }
    }

    try {
      const summary = await runScheduledMaintenance();
      res.json({ ok: true, summary });
    } catch (err) {
      console.error('[cron/maintenance]', redactSecrets(err instanceof Error ? err.message : 'err'));
      res.status(500).json({ ok: false, error: 'Maintenance run failed' });
    }
  };

  router.get('/cron/maintenance', handleMaintenanceCron);
  router.post('/cron/maintenance', handleMaintenanceCron);

  // =========================================================================
  // 2. UPSTASH QSTASH WORKER ENDPOINTS (Cryptographic Signature Verification)
  // =========================================================================
  const verifyQStashMiddleware = async (
    req: RawBodyRequest,
    res: Response,
  ): Promise<boolean> => {
    const signature = req.headers['upstash-signature'];
    const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
    const check = await verifyQStashSignature({
      signature: typeof signature === 'string' ? signature : undefined,
      rawBody,
      url: getFullRequestUrl(req),
    });

    if (!check.ok) {
      res.status(401).json({
        ok: false,
        error: 'Unauthorized background worker request',
        code: check.reason ?? 'INVALID_QSTASH_SIGNATURE',
      });
      return false;
    }
    return true;
  };

  router.post('/jobs/process', async (req: RawBodyRequest, res: Response) => {
    if (!(await verifyQStashMiddleware(req, res))) return;
    try {
      const payload = req.body as QueuedJobPayload;
      if (!payload || !payload.kind) {
        res.status(400).json({ ok: false, error: 'Missing job payload' });
        return;
      }
      await dispatchJobPayload(payload);
      res.json({ ok: true });
    } catch (err) {
      console.error('[jobs/process]', redactSecrets(err instanceof Error ? err.message : 'unknown'));
      res.status(500).json({ ok: false, error: 'Job execution failed' });
    }
  });

  router.post('/jobs/poll', async (req: RawBodyRequest, res: Response) => {
    if (!(await verifyQStashMiddleware(req, res))) return;
    try {
      const payload = req.body as QueuedJobPayload;
      if (!payload?.jobId) {
        res.status(400).json({ ok: false, error: 'Missing jobId' });
        return;
      }
      const result = await executeVideoPollJob(payload.jobId);
      res.json({ ok: true, result });
    } catch (err) {
      console.error('[jobs/poll]', redactSecrets(err instanceof Error ? err.message : 'unknown'));
      res.status(500).json({ ok: false, error: 'Video poll failed' });
    }
  });

  router.post('/jobs/failed', async (req: RawBodyRequest, res: Response) => {
    if (!(await verifyQStashMiddleware(req, res))) return;
    try {
      const body = req.body as {
        sourceBody?: string;
        body?: QueuedJobPayload;
        jobId?: string;
        requestId?: string;
      };
      let payload: QueuedJobPayload | null = body?.body ?? null;
      if (!payload && typeof body?.sourceBody === 'string') {
        try {
          payload = JSON.parse(Buffer.from(body.sourceBody, 'base64').toString('utf8')) as QueuedJobPayload;
        } catch {
          try {
            payload = JSON.parse(body.sourceBody) as QueuedJobPayload;
          } catch {
            payload = null;
          }
        }
      }
      const requestId = payload?.requestId ?? body?.requestId;
      const jobId = payload?.jobId ?? body?.jobId;
      if (requestId) {
        await refundFailedRequest({
          requestId,
          jobId,
          errorCode: 'QUEUE_RETRIES_EXHAUSTED',
          errorMessage: 'Background job failed after maximum QStash retries',
        });
      }
      res.json({ ok: true, refunded: Boolean(requestId) });
    } catch (err) {
      console.error('[jobs/failed]', redactSecrets(err instanceof Error ? err.message : 'unknown'));
      res.status(500).json({ ok: false });
    }
  });

  return router;
}
