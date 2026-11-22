import { Router, type Response } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { aiModels, aiProviders, providerCredentials, telegramBotSettings } from '../../db/schema.ts';
import {
  providerCreateSchema,
  providerRotateKeySchema,
  providerUpdateSchema,
} from '../../shared/validation.ts';
import {
  decryptSecret,
  EncryptionKeyUnavailableError,
  encryptSecret,
  maskSecret,
} from '../security/crypto.ts';
import { testProviderConnection } from '../providers/adapters.ts';
import { recordAuditLog } from '../security/audit.ts';
import { SsrfProtectionError, validatePublicHttpsUrl } from '../security/ssrf.ts';
import {
  getClientIp,
  requireAdminAuth,
  requireRole,
  type AdminRequest,
} from '../middleware/auth.ts';

function slugifyProviderName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base || 'provider'}-${suffix}`;
}

export function createProviderRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);

  // List providers with strictly masked credential preview (never raw or encrypted values)
  router.get('/providers', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [providers, credentials, models] = await Promise.all([
        db.select().from(aiProviders).orderBy(aiProviders.priority, desc(aiProviders.createdAt)),
        db
          .select({
            id: providerCredentials.id,
            providerId: providerCredentials.providerId,
            label: providerCredentials.label,
            keyVersion: providerCredentials.keyVersion,
            maskedPreview: providerCredentials.maskedPreview,
            isActive: providerCredentials.isActive,
            rotatedAt: providerCredentials.rotatedAt,
            createdAt: providerCredentials.createdAt,
          })
          .from(providerCredentials)
          .where(eq(providerCredentials.isActive, true)),
        db.select({ id: aiModels.id, providerId: aiModels.providerId, isActive: aiModels.isActive }).from(aiModels),
      ]);

      const credByProvider = new Map(credentials.map((c) => [c.providerId, c]));
      const modelStats = new Map<string, { total: number; active: number }>();
      for (const m of models) {
        const cur = modelStats.get(m.providerId) ?? { total: 0, active: 0 };
        cur.total += 1;
        if (m.isActive) cur.active += 1;
        modelStats.set(m.providerId, cur);
      }

      res.json({
        providers: providers.map((p) => {
          const cred = credByProvider.get(p.id);
          const stats = modelStats.get(p.id) ?? { total: 0, active: 0 };
          return {
            id: p.id,
            name: p.name,
            slug: p.slug,
            providerType: p.providerType,
            baseUrl: p.baseUrl,
            organizationId: p.organizationId,
            additionalHeaders: p.additionalHeaders,
            connectionStatus: p.connectionStatus,
            lastTestMessage: p.lastTestMessage,
            lastTestLatencyMs: p.lastTestLatencyMs,
            lastTestedAt: p.lastTestedAt,
            isActive: p.isActive,
            priority: p.priority,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            hasCredential: Boolean(cred),
            maskedApiKey: cred?.maskedPreview ?? null,
            keyVersion: cred?.keyVersion ?? null,
            modelsTotal: stats.total,
            modelsActive: stats.active,
          };
        }),
      });
    } catch (err) {
      console.error('[providers/list]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت فهرست ارائه‌دهندگان هوش مصنوعی.' });
    }
  });

  // Create provider + AES-256-GCM encrypted credential in a DB transaction
  router.post('/providers', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = providerCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message ?? 'اطلاعات ارائه‌دهنده نامعتبر است.',
          issues: parsed.error.issues,
        });
        return;
      }

      const data = parsed.data;
      try {
        validatePublicHttpsUrl(data.baseUrl);
      } catch (ssrfErr) {
        res.status(400).json({
          error:
            ssrfErr instanceof SsrfProtectionError
              ? ssrfErr.message
              : 'آدرس Base URL باید یک دامنه عمومی معتبر با پروتکل HTTPS باشد.',
          code: 'SSRF_BLOCKED',
        });
        return;
      }
      const encrypted = encryptSecret(data.apiKey);
      const maskedPreview = maskSecret(data.apiKey);
      const db = getDb();

      const created = await db.transaction(async (tx) => {
        const [provider] = await tx
          .insert(aiProviders)
          .values({
            name: data.name,
            slug: slugifyProviderName(data.name),
            providerType: data.providerType,
            baseUrl: data.baseUrl,
            organizationId: data.organizationId || null,
            additionalHeaders: data.additionalHeaders ?? {},
            isActive: data.isActive,
            priority: data.priority,
          })
          .returning();

        if (!provider) throw new Error('Insert provider failed');

        await tx.insert(providerCredentials).values({
          providerId: provider.id,
          label: 'primary',
          encryptedApiKey: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: 1,
          maskedPreview,
          isActive: true,
        });

        return provider;
      });

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'provider.created',
        resourceType: 'ai_provider',
        resourceId: created.id,
        severity: 'info',
        ipAddress: ip,
        userAgent: ua,
        details: {
          name: created.name,
          providerType: created.providerType,
          baseUrl: created.baseUrl,
          maskedApiKey: maskedPreview,
        },
        extraSecretsToRedact: [data.apiKey],
      });

      res.status(201).json({
        provider: {
          ...created,
          hasCredential: true,
          maskedApiKey: maskedPreview,
          keyVersion: 1,
          modelsTotal: 0,
          modelsActive: 0,
        },
      });
    } catch (err) {
      if (err instanceof EncryptionKeyUnavailableError) {
        res.status(503).json({ error: err.message, code: 'ENCRYPTION_KEY_MISSING' });
        return;
      }
      console.error('[providers/create]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در ذخیره ارائه‌دهنده هوش مصنوعی.' });
    }
  });

  router.patch('/providers/:id', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = providerUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'اطلاعات نامعتبر است.' });
        return;
      }
      if (parsed.data.baseUrl) {
        try {
          validatePublicHttpsUrl(parsed.data.baseUrl);
        } catch (ssrfErr) {
          res.status(400).json({
            error:
              ssrfErr instanceof SsrfProtectionError
                ? ssrfErr.message
                : 'آدرس Base URL باید یک دامنه عمومی معتبر با پروتکل HTTPS باشد.',
            code: 'SSRF_BLOCKED',
          });
          return;
        }
      }
      const db = getDb();
      const [updated] = await db
        .update(aiProviders)
        .set({
          ...parsed.data,
          organizationId:
            parsed.data.organizationId === '' ? null : parsed.data.organizationId,
          updatedAt: new Date(),
        })
        .where(eq(aiProviders.id, id))
        .returning();

      if (!updated) {
        res.status(404).json({ error: 'ارائه‌دهنده مورد نظر یافت نشد.' });
        return;
      }

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'provider.updated',
        resourceType: 'ai_provider',
        resourceId: updated.id,
        ipAddress: ip,
        userAgent: ua,
        details: { name: updated.name, isActive: updated.isActive, priority: updated.priority },
      });

      res.json({ provider: updated });
    } catch (err) {
      console.error('[providers/update]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در به‌روزرسانی ارائه‌دهنده.' });
    }
  });

  router.delete('/providers/:id', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const db = getDb();
      const [deleted] = await db
        .delete(aiProviders)
        .where(eq(aiProviders.id, id))
        .returning({ id: aiProviders.id, name: aiProviders.name });

      if (!deleted) {
        res.status(404).json({ error: 'ارائه‌دهنده مورد نظر یافت نشد.' });
        return;
      }

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'provider.deleted',
        resourceType: 'ai_provider',
        resourceId: deleted.id,
        severity: 'warning',
        ipAddress: ip,
        userAgent: ua,
        details: { name: deleted.name },
      });

      res.json({ ok: true, id: deleted.id });
    } catch (err) {
      console.error('[providers/delete]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در حذف ارائه‌دهنده.' });
    }
  });

  // Secure Key Rotation (transactional)
  router.post(
    '/providers/:id/rotate-key',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      const providerId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const parsed = providerRotateKeySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'کلید جدید نامعتبر است.' });
          return;
        }

        const db = getDb();
        const [provider] = await db
          .select({ id: aiProviders.id, name: aiProviders.name })
          .from(aiProviders)
          .where(eq(aiProviders.id, providerId))
          .limit(1);

        if (!provider) {
          res.status(404).json({ error: 'ارائه‌دهنده یافت نشد.' });
          return;
        }

        const encrypted = encryptSecret(parsed.data.apiKey);
        const maskedPreview = maskSecret(parsed.data.apiKey);
        const now = new Date();

        const newCred = await db.transaction(async (tx) => {
          const existing = await tx
            .select({ id: providerCredentials.id, keyVersion: providerCredentials.keyVersion })
            .from(providerCredentials)
            .where(eq(providerCredentials.providerId, providerId))
            .orderBy(desc(providerCredentials.keyVersion));

          const nextVersion = (existing[0]?.keyVersion ?? 0) + 1;

          await tx
            .update(providerCredentials)
            .set({ isActive: false, revokedAt: now, updatedAt: now })
            .where(
              and(
                eq(providerCredentials.providerId, providerId),
                eq(providerCredentials.isActive, true),
              ),
            );

          const [inserted] = await tx
            .insert(providerCredentials)
            .values({
              providerId,
              label: parsed.data.label,
              encryptedApiKey: encrypted.ciphertext,
              iv: encrypted.iv,
              authTag: encrypted.authTag,
              keyVersion: nextVersion,
              maskedPreview,
              isActive: true,
              rotatedAt: now,
            })
            .returning({
              id: providerCredentials.id,
              keyVersion: providerCredentials.keyVersion,
              maskedPreview: providerCredentials.maskedPreview,
              rotatedAt: providerCredentials.rotatedAt,
            });

          await tx
            .update(aiProviders)
            .set({ connectionStatus: 'untested', updatedAt: now })
            .where(eq(aiProviders.id, providerId));

          return inserted;
        });

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'provider.key_rotated',
          resourceType: 'provider_credential',
          resourceId: newCred?.id,
          severity: 'warning',
          ipAddress: ip,
          userAgent: ua,
          details: {
            providerName: provider.name,
            keyVersion: newCred?.keyVersion,
            maskedPreview,
          },
          extraSecretsToRedact: [parsed.data.apiKey],
        });

        res.json({ ok: true, credential: newCred });
      } catch (err) {
        if (err instanceof EncryptionKeyUnavailableError) {
          res.status(503).json({ error: err.message, code: 'ENCRYPTION_KEY_MISSING' });
          return;
        }
        console.error('[providers/rotate-key]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در چرخش کلید امنیتی.' });
      }
    },
  );

  // Real Live Provider Connection Test (protocol-specific adapter)
  router.post(
    '/providers/:id/test',
    requireRole('operator'),
    async (req: AdminRequest, res: Response) => {
      const providerId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const db = getDb();
        const [provider] = await db
          .select()
          .from(aiProviders)
          .where(eq(aiProviders.id, providerId))
          .limit(1);

        if (!provider) {
          res.status(404).json({ error: 'ارائه‌دهنده یافت نشد.' });
          return;
        }

        const [cred] = await db
          .select()
          .from(providerCredentials)
          .where(
            and(
              eq(providerCredentials.providerId, providerId),
              eq(providerCredentials.isActive, true),
            ),
          )
          .orderBy(desc(providerCredentials.keyVersion))
          .limit(1);

        if (!cred) {
          res.status(400).json({
            error: 'هیچ کلید API فعالی برای این ارائه‌دهنده ثبت نشده است.',
            code: 'NO_ACTIVE_CREDENTIAL',
          });
          return;
        }

        const rawApiKey = decryptSecret({
          ciphertext: cred.encryptedApiKey,
          iv: cred.iv,
          authTag: cred.authTag,
        });

        const testResult = await testProviderConnection({
          providerType: provider.providerType,
          baseUrl: provider.baseUrl,
          apiKey: rawApiKey,
          organizationId: provider.organizationId,
          additionalHeaders: provider.additionalHeaders ?? {},
        });

        const now = new Date();
        await db
          .update(aiProviders)
          .set({
            connectionStatus: testResult.status,
            lastTestLatencyMs: testResult.latencyMs,
            lastTestMessage: testResult.message,
            lastTestedAt: now,
            updatedAt: now,
          })
          .where(eq(aiProviders.id, providerId));

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'provider.connection_tested',
          resourceType: 'ai_provider',
          resourceId: providerId,
          severity: testResult.ok ? 'info' : 'warning',
          status: testResult.ok ? 'success' : 'failure',
          ipAddress: ip,
          userAgent: ua,
          details: {
            providerName: provider.name,
            protocol: testResult.protocol,
            httpStatus: testResult.httpStatus,
            latencyMs: testResult.latencyMs,
            status: testResult.status,
          },
          extraSecretsToRedact: [rawApiKey],
        });

        res.json({ result: testResult });
      } catch (err) {
        if (err instanceof EncryptionKeyUnavailableError) {
          res.status(503).json({ error: err.message, code: 'ENCRYPTION_KEY_MISSING' });
          return;
        }
        console.error('[providers/test]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در اجرای تست اتصال ارائه‌دهنده.' });
      }
    },
  );

  // API Credentials Vault (strictly metadata + masked previews)
  router.get('/credentials', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [creds, tgRows] = await Promise.all([
        db
          .select({
            id: providerCredentials.id,
            providerId: providerCredentials.providerId,
            providerName: aiProviders.name,
            providerType: aiProviders.providerType,
            label: providerCredentials.label,
            keyVersion: providerCredentials.keyVersion,
            maskedPreview: providerCredentials.maskedPreview,
            isActive: providerCredentials.isActive,
            rotatedAt: providerCredentials.rotatedAt,
            revokedAt: providerCredentials.revokedAt,
            createdAt: providerCredentials.createdAt,
          })
          .from(providerCredentials)
          .innerJoin(aiProviders, eq(providerCredentials.providerId, aiProviders.id))
          .orderBy(desc(providerCredentials.createdAt)),
        db
          .select({
            id: telegramBotSettings.id,
            botUsername: telegramBotSettings.botUsername,
            maskedBotToken: telegramBotSettings.maskedBotToken,
            maskedWebhookSecret: telegramBotSettings.maskedWebhookSecret,
            isActive: telegramBotSettings.isActive,
            updatedAt: telegramBotSettings.updatedAt,
          })
          .from(telegramBotSettings)
          .limit(1),
      ]);

      res.json({
        providerCredentials: creds.map((c) => ({
          ...c,
          encryptionAlgorithm: 'AES-256-GCM',
        })),
        telegramCredential: tgRows[0]
          ? {
              configured: Boolean(tgRows[0].maskedBotToken),
              botUsername: tgRows[0].botUsername,
              maskedBotToken: tgRows[0].maskedBotToken,
              maskedWebhookSecret: tgRows[0].maskedWebhookSecret,
              encryptionAlgorithm: 'AES-256-GCM',
              updatedAt: tgRows[0].updatedAt,
            }
          : null,
      });
    } catch (err) {
      console.error('[credentials/list]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت خزانه اعتبارنامه‌ها.' });
    }
  });

  router.post(
    '/credentials/:id/revoke',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      const credId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const db = getDb();
        const now = new Date();
        const [revoked] = await db
          .update(providerCredentials)
          .set({ isActive: false, revokedAt: now, updatedAt: now })
          .where(eq(providerCredentials.id, credId))
          .returning({ id: providerCredentials.id, maskedPreview: providerCredentials.maskedPreview });

        if (!revoked) {
          res.status(404).json({ error: 'اعتبارنامه یافت نشد.' });
          return;
        }

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'credential.revoked',
          resourceType: 'provider_credential',
          resourceId: revoked.id,
          severity: 'warning',
          ipAddress: ip,
          userAgent: ua,
          details: { maskedPreview: revoked.maskedPreview },
        });

        res.json({ ok: true });
      } catch (err) {
        console.error('[credentials/revoke]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در باطل‌سازی اعتبارنامه.' });
      }
    },
  );

  return router;
}
