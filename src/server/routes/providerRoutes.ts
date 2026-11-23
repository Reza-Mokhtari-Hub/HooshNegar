import { Router, type Response } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { aiModels, aiProviders, providerCredentials, telegramBotSettings } from '../../db/schema.ts';
import {
  providerCreateSchema,
  providerCredentialCreateSchema,
  providerCredentialUpdateSchema,
  providerRotateKeySchema,
  providerSyncModelsSchema,
  providerUpdateSchema,
} from '../../shared/validation.ts';
import {
  decryptSecret,
  EncryptionKeyUnavailableError,
  encryptSecret,
  maskSecret,
} from '../security/crypto.ts';
import { testProviderConnection } from '../providers/adapters.ts';
import {
  discoverProviderModels,
  syncProviderModelsToDatabase,
  type SyncModelsResult,
} from '../providers/discovery.ts';
import { recordAuditLog } from '../security/audit.ts';
import { getCloudflareAiBinding } from '../cloudflare/requestContext.ts';
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

function isCredentialHealthy(
  cred: { isActive: boolean; status: string; cooldownUntil: Date | null },
  nowMs: number,
): boolean {
  if (!cred.isActive) return false;
  if (cred.status === 'invalid' || cred.status === 'disabled') return false;
  if (cred.cooldownUntil && new Date(cred.cooldownUntil).getTime() > nowMs) return false;
  return cred.status === 'active' || cred.status === 'rate_limited' || cred.status === 'quota_exhausted';
}

export function createProviderRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);

  // List providers with masked primary key + credential pool health stats (never raw or encrypted values)
  router.get('/providers', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const nowMs = Date.now();
      const [providers, credentials, models] = await Promise.all([
        db.select().from(aiProviders).orderBy(aiProviders.priority, desc(aiProviders.createdAt)),
        db
          .select({
            id: providerCredentials.id,
            providerId: providerCredentials.providerId,
            label: providerCredentials.label,
            keyVersion: providerCredentials.keyVersion,
            maskedPreview: providerCredentials.maskedPreview,
            priority: providerCredentials.priority,
            status: providerCredentials.status,
            cooldownUntil: providerCredentials.cooldownUntil,
            failureCount: providerCredentials.failureCount,
            isActive: providerCredentials.isActive,
            rotatedAt: providerCredentials.rotatedAt,
            createdAt: providerCredentials.createdAt,
          })
          .from(providerCredentials)
          .where(eq(providerCredentials.isActive, true))
          .orderBy(asc(providerCredentials.priority), desc(providerCredentials.keyVersion)),
        db.select({ id: aiModels.id, providerId: aiModels.providerId, isActive: aiModels.isActive }).from(aiModels),
      ]);

      const credsByProvider = new Map<string, typeof credentials>();
      for (const c of credentials) {
        const list = credsByProvider.get(c.providerId) ?? [];
        list.push(c);
        credsByProvider.set(c.providerId, list);
      }

      const modelStats = new Map<string, { total: number; active: number }>();
      for (const m of models) {
        const cur = modelStats.get(m.providerId) ?? { total: 0, active: 0 };
        cur.total += 1;
        if (m.isActive) cur.active += 1;
        modelStats.set(m.providerId, cur);
      }

      res.json({
        providers: providers.map((p) => {
          const pool = credsByProvider.get(p.id) ?? [];
          const primaryCred = pool.find((c) => isCredentialHealthy(c, nowMs)) ?? pool[0];
          const healthyKeysCount = pool.filter((c) => isCredentialHealthy(c, nowMs)).length;
          const exhaustedKeysCount = pool.filter(
            (c) =>
              c.status === 'quota_exhausted' ||
              c.status === 'rate_limited' ||
              Boolean(c.cooldownUntil && new Date(c.cooldownUntil).getTime() > nowMs),
          ).length;
          const invalidKeysCount = pool.filter((c) => c.status === 'invalid').length;
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
            hasCredential: pool.length > 0,
            maskedApiKey: primaryCred?.maskedPreview ?? null,
            keyVersion: primaryCred?.keyVersion ?? null,
            activeKeysCount: pool.length,
            healthyKeysCount,
            exhaustedKeysCount,
            invalidKeysCount,
            primaryCredentialStatus: primaryCred?.status ?? null,
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

  // Create provider + AES-256-GCM encrypted credential pool + optional live auto model sync
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

      const rawKeys = Array.from(
        new Set(
          [data.apiKey, ...(data.apiKeys ?? [])]
            .map((k) => k.trim())
            .filter((k) => k.length > 0),
        ),
      );

      const encryptedPool = rawKeys.map((key, idx) => ({
        label: idx === 0 ? 'primary' : `backup-${idx}`,
        encrypted: encryptSecret(key),
        maskedPreview: maskSecret(key),
        keyVersion: idx + 1,
        priority: 100 + idx,
      }));

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

        if (encryptedPool.length > 0) {
          await tx.insert(providerCredentials).values(
            encryptedPool.map((item) => ({
              providerId: provider.id,
              label: item.label,
              encryptedApiKey: item.encrypted.ciphertext,
              iv: item.encrypted.iv,
              authTag: item.encrypted.authTag,
              keyVersion: item.keyVersion,
              maskedPreview: item.maskedPreview,
              priority: item.priority,
              status: 'active',
              isActive: true,
            })),
          );
        }

        return provider;
      });

      let updatedProvider = created;
      let testResult: Awaited<ReturnType<typeof testProviderConnection>> | null = null;
      let syncResult: SyncModelsResult | null = null;

      if (data.autoSyncModels !== false) {
        const primaryRawKey = rawKeys[0] ?? '';
        try {
          testResult = await testProviderConnection({
            providerType: created.providerType,
            baseUrl: created.baseUrl,
            apiKey: primaryRawKey,
            organizationId: created.organizationId,
            additionalHeaders: created.additionalHeaders ?? {},
          });

          const now = new Date();
          const [savedProv] = await db
            .update(aiProviders)
            .set({
              connectionStatus: testResult.status,
              lastTestLatencyMs: testResult.latencyMs,
              lastTestMessage: testResult.message,
              lastTestedAt: now,
              updatedAt: now,
            })
            .where(eq(aiProviders.id, created.id))
            .returning();
          if (savedProv) updatedProvider = savedProv;
        } catch {
          // Best-effort initial probe; provider is still safely created
        }

        try {
          const discovered = await discoverProviderModels({
            providerType: created.providerType,
            baseUrl: created.baseUrl,
            apiKey: primaryRawKey,
            organizationId: created.organizationId,
            additionalHeaders: created.additionalHeaders ?? {},
          });
          if (discovered.ok && discovered.models.length > 0) {
            syncResult = await syncProviderModelsToDatabase({
              providerId: created.id,
              providerType: created.providerType,
              discoveredModels: discovered.models,
              activateAll: true,
            });
          } else {
            syncResult = {
              discoveredCount: 0,
              createdCount: 0,
              skippedCount: 0,
              createdModelIds: [],
              discoveredModels: [],
              resolvedBaseUrl: discovered.resolvedBaseUrl,
              message: discovered.message,
            };
          }
        } catch {
          // Non-fatal auto-sync error
        }
      }

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
          keysCount: encryptedPool.length,
          maskedApiKey: encryptedPool[0]?.maskedPreview ?? null,
          autoSyncedModels: syncResult?.createdCount ?? 0,
        },
        extraSecretsToRedact: rawKeys,
      });

      const createdCount = syncResult?.createdCount ?? 0;

      res.status(201).json({
        provider: {
          ...updatedProvider,
          hasCredential: encryptedPool.length > 0,
          maskedApiKey: encryptedPool[0]?.maskedPreview ?? null,
          keyVersion: encryptedPool[0]?.keyVersion ?? null,
          activeKeysCount: encryptedPool.length,
          healthyKeysCount: encryptedPool.length,
          exhaustedKeysCount: 0,
          invalidKeysCount: 0,
          primaryCredentialStatus: encryptedPool.length > 0 ? 'active' : null,
          modelsTotal: createdCount,
          modelsActive: createdCount,
        },
        testResult,
        syncResult,
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

  // List credential pool for a specific provider
  router.get('/providers/:id/credentials', async (req: AdminRequest, res: Response) => {
    const providerId = String(req.params.id ?? '');
    try {
      const db = getDb();
      const [provider] = await db
        .select({ id: aiProviders.id, name: aiProviders.name, providerType: aiProviders.providerType })
        .from(aiProviders)
        .where(eq(aiProviders.id, providerId))
        .limit(1);

      if (!provider) {
        res.status(404).json({ error: 'ارائه‌دهنده یافت نشد.' });
        return;
      }

      const credentials = await db
        .select({
          id: providerCredentials.id,
          providerId: providerCredentials.providerId,
          label: providerCredentials.label,
          keyVersion: providerCredentials.keyVersion,
          maskedPreview: providerCredentials.maskedPreview,
          priority: providerCredentials.priority,
          status: providerCredentials.status,
          cooldownUntil: providerCredentials.cooldownUntil,
          failureCount: providerCredentials.failureCount,
          lastUsedAt: providerCredentials.lastUsedAt,
          lastErrorCode: providerCredentials.lastErrorCode,
          lastErrorMessage: providerCredentials.lastErrorMessage,
          isActive: providerCredentials.isActive,
          rotatedAt: providerCredentials.rotatedAt,
          revokedAt: providerCredentials.revokedAt,
          createdAt: providerCredentials.createdAt,
          updatedAt: providerCredentials.updatedAt,
        })
        .from(providerCredentials)
        .where(eq(providerCredentials.providerId, providerId))
        .orderBy(asc(providerCredentials.priority), desc(providerCredentials.keyVersion));

      res.json({ provider, credentials });
    } catch (err) {
      console.error('[providers/credentials/list]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت استخر کلیدهای ارائه‌دهنده.' });
    }
  });

  // Add one or multiple backup API keys to provider pool without revoking existing keys
  router.post(
    '/providers/:id/credentials',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      const providerId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const parsed = providerCredentialCreateSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: parsed.error.issues[0]?.message ?? 'اطلاعات کلید API نامعتبر است.',
            issues: parsed.error.issues,
          });
          return;
        }

        const rawKeys = Array.from(
          new Set(
            [parsed.data.apiKey, ...(parsed.data.apiKeys ?? [])]
              .map((k) => k.trim())
              .filter((k) => k.length > 0),
          ),
        );
        if (rawKeys.length === 0) {
          res.status(400).json({ error: 'حداقل یک کلید API معتبر وارد کنید.' });
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

        const encryptedItems = rawKeys.map((k) => ({
          encrypted: encryptSecret(k),
          maskedPreview: maskSecret(k),
        }));

        const inserted = await db.transaction(async (tx) => {
          const existing = await tx
            .select({ keyVersion: providerCredentials.keyVersion })
            .from(providerCredentials)
            .where(eq(providerCredentials.providerId, providerId))
            .orderBy(desc(providerCredentials.keyVersion));

          const startVersion = (existing[0]?.keyVersion ?? 0) + 1;
          const basePriority = parsed.data.priority ?? 100;

          return tx
            .insert(providerCredentials)
            .values(
              encryptedItems.map((item, idx) => ({
                providerId,
                label:
                  rawKeys.length > 1
                    ? `${parsed.data.label}-${startVersion + idx}`
                    : parsed.data.label,
                encryptedApiKey: item.encrypted.ciphertext,
                iv: item.encrypted.iv,
                authTag: item.encrypted.authTag,
                keyVersion: startVersion + idx,
                maskedPreview: item.maskedPreview,
                priority: basePriority + idx,
                status: 'active',
                isActive: true,
              })),
            )
            .returning({
              id: providerCredentials.id,
              label: providerCredentials.label,
              keyVersion: providerCredentials.keyVersion,
              maskedPreview: providerCredentials.maskedPreview,
              priority: providerCredentials.priority,
              status: providerCredentials.status,
              isActive: providerCredentials.isActive,
              createdAt: providerCredentials.createdAt,
            });
        });

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'provider.credentials_added',
          resourceType: 'provider_credential',
          resourceId: providerId,
          severity: 'info',
          ipAddress: ip,
          userAgent: ua,
          details: {
            providerName: provider.name,
            addedCount: inserted.length,
            maskedPreviews: inserted.map((c) => c.maskedPreview),
          },
          extraSecretsToRedact: rawKeys,
        });

        res.status(201).json({ ok: true, credentials: inserted });
      } catch (err) {
        if (err instanceof EncryptionKeyUnavailableError) {
          res.status(503).json({ error: err.message, code: 'ENCRYPTION_KEY_MISSING' });
          return;
        }
        console.error('[providers/credentials/create]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در افزودن کلید به استخر ارائه‌دهنده.' });
      }
    },
  );

  // Update credential priority, label, active flag, or reset cooldown/quota status
  router.patch('/credentials/:id', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const credId = String(req.params.id ?? '');
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = providerCredentialUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'اطلاعات نامعتبر است.' });
        return;
      }

      const db = getDb();
      const now = new Date();
      const patch: Partial<typeof providerCredentials.$inferInsert> = {
        updatedAt: now,
      };
      if (parsed.data.label !== undefined) patch.label = parsed.data.label;
      if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;
      if (parsed.data.isActive !== undefined) {
        patch.isActive = parsed.data.isActive;
        patch.revokedAt = parsed.data.isActive ? null : now;
      }
      if (parsed.data.resetStatus) {
        patch.status = 'active';
        patch.cooldownUntil = null;
        patch.failureCount = 0;
        patch.lastErrorCode = null;
        patch.lastErrorMessage = null;
        if (parsed.data.isActive === undefined) {
          patch.isActive = true;
          patch.revokedAt = null;
        }
      }

      const [updated] = await db
        .update(providerCredentials)
        .set(patch)
        .where(eq(providerCredentials.id, credId))
        .returning({
          id: providerCredentials.id,
          providerId: providerCredentials.providerId,
          label: providerCredentials.label,
          keyVersion: providerCredentials.keyVersion,
          maskedPreview: providerCredentials.maskedPreview,
          priority: providerCredentials.priority,
          status: providerCredentials.status,
          cooldownUntil: providerCredentials.cooldownUntil,
          failureCount: providerCredentials.failureCount,
          lastErrorCode: providerCredentials.lastErrorCode,
          lastErrorMessage: providerCredentials.lastErrorMessage,
          isActive: providerCredentials.isActive,
          updatedAt: providerCredentials.updatedAt,
        });

      if (!updated) {
        res.status(404).json({ error: 'اعتبارنامه یافت نشد.' });
        return;
      }

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'credential.updated',
        resourceType: 'provider_credential',
        resourceId: updated.id,
        ipAddress: ip,
        userAgent: ua,
        details: {
          maskedPreview: updated.maskedPreview,
          priority: updated.priority,
          status: updated.status,
          isActive: updated.isActive,
          resetStatus: Boolean(parsed.data.resetStatus),
        },
      });

      res.json({ ok: true, credential: updated });
    } catch (err) {
      console.error('[credentials/update]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در به‌روزرسانی اعتبارنامه.' });
    }
  });

  // Discover and optionally auto-register all models from provider endpoint
  router.post(
    '/providers/:id/sync-models',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      const providerId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const parsed = providerSyncModelsSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: 'پارامترهای همگام‌سازی نامعتبر است.' });
          return;
        }

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

        const activeCreds = await db
          .select()
          .from(providerCredentials)
          .where(
            and(
              eq(providerCredentials.providerId, providerId),
              eq(providerCredentials.isActive, true),
            ),
          )
          .orderBy(asc(providerCredentials.priority), desc(providerCredentials.keyVersion));

        const nowMs = Date.now();
        const bestCred =
          activeCreds.find((c) => isCredentialHealthy(c, nowMs)) ?? activeCreds[0] ?? null;

        const isKeylessAllowed =
          provider.providerType === 'huggingface_space' ||
          (provider.providerType === 'cloudflare_workers_ai' && Boolean(getCloudflareAiBinding()));

        if (!bestCred && !isKeylessAllowed) {
          res.status(400).json({
            error: 'هیچ کلید API فعالی برای این ارائه‌دهنده ثبت نشده است.',
            code: 'NO_ACTIVE_CREDENTIAL',
          });
          return;
        }

        const rawApiKey = bestCred
          ? decryptSecret({
              ciphertext: bestCred.encryptedApiKey,
              iv: bestCred.iv,
              authTag: bestCred.authTag,
            })
          : '';

        const discoverRes = await discoverProviderModels({
          providerType: provider.providerType,
          baseUrl: provider.baseUrl,
          apiKey: rawApiKey,
          organizationId: provider.organizationId,
          additionalHeaders: provider.additionalHeaders ?? {},
        });

        const now = new Date();
        if (discoverRes.ok) {
          await db
            .update(aiProviders)
            .set({
              connectionStatus: 'connected',
              lastTestMessage: discoverRes.message,
              lastTestedAt: now,
              updatedAt: now,
            })
            .where(eq(aiProviders.id, providerId));

          if (bestCred) {
            await db
              .update(providerCredentials)
              .set({
                status: 'active',
                cooldownUntil: null,
                failureCount: 0,
                lastErrorCode: null,
                lastErrorMessage: null,
                updatedAt: now,
              })
              .where(eq(providerCredentials.id, bestCred.id));
          }
        }

        if (!discoverRes.ok) {
          res.status(502).json({
            ok: false,
            error: discoverRes.message,
            discoveredModels: [],
          });
          return;
        }

        if (parsed.data.discoverOnly) {
          res.json({
            ok: true,
            discoverOnly: true,
            discoveredCount: discoverRes.models.length,
            createdCount: 0,
            skippedCount: 0,
            createdModelIds: [],
            discoveredModels: discoverRes.models,
            resolvedBaseUrl: discoverRes.resolvedBaseUrl,
            message: discoverRes.message,
          });
          return;
        }

        const syncResult = await syncProviderModelsToDatabase({
          providerId: provider.id,
          providerType: provider.providerType,
          discoveredModels: discoverRes.models,
          activateAll: parsed.data.activateAll,
          defaultCreditCost: parsed.data.defaultCreditCost,
        });

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'provider.models_synced',
          resourceType: 'ai_provider',
          resourceId: provider.id,
          severity: 'info',
          ipAddress: ip,
          userAgent: ua,
          details: {
            providerName: provider.name,
            discoveredCount: syncResult.discoveredCount,
            createdCount: syncResult.createdCount,
            skippedCount: syncResult.skippedCount,
          },
          extraSecretsToRedact: rawApiKey ? [rawApiKey] : [],
        });

        res.json({
          ok: true,
          ...syncResult,
          resolvedBaseUrl: discoverRes.resolvedBaseUrl,
        });
      } catch (err) {
        if (err instanceof EncryptionKeyUnavailableError) {
          res.status(503).json({ error: err.message, code: 'ENCRYPTION_KEY_MISSING' });
          return;
        }
        console.error('[providers/sync-models]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در شناسایی و همگام‌سازی خودکار مدل‌ها.' });
      }
    },
  );

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
            .set({ isActive: false, status: 'disabled', revokedAt: now, updatedAt: now })
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
              priority: 100,
              status: 'active',
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

        const creds = await db
          .select()
          .from(providerCredentials)
          .where(
            and(
              eq(providerCredentials.providerId, providerId),
              eq(providerCredentials.isActive, true),
            ),
          )
          .orderBy(asc(providerCredentials.priority), desc(providerCredentials.keyVersion));

        const nowMs = Date.now();
        const cred = creds.find((c) => isCredentialHealthy(c, nowMs)) ?? creds[0] ?? null;

        const isKeylessAllowed =
          provider.providerType === 'huggingface_space' ||
          (provider.providerType === 'cloudflare_workers_ai' && Boolean(getCloudflareAiBinding()));

        if (!cred && !isKeylessAllowed) {
          res.status(400).json({
            error: 'هیچ کلید API فعالی برای این ارائه‌دهنده ثبت نشده است.',
            code: 'NO_ACTIVE_CREDENTIAL',
          });
          return;
        }

        const rawApiKey = cred
          ? decryptSecret({
              ciphertext: cred.encryptedApiKey,
              iv: cred.iv,
              authTag: cred.authTag,
            })
          : '';

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

        if (testResult.ok && cred) {
          await db
            .update(providerCredentials)
            .set({
              status: 'active',
              cooldownUntil: null,
              failureCount: 0,
              lastErrorCode: null,
              lastErrorMessage: null,
              updatedAt: now,
            })
            .where(eq(providerCredentials.id, cred.id));
        }

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
          extraSecretsToRedact: rawApiKey ? [rawApiKey] : [],
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

  // API Credentials Vault (strictly metadata + masked previews + pool health)
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
            priority: providerCredentials.priority,
            status: providerCredentials.status,
            cooldownUntil: providerCredentials.cooldownUntil,
            failureCount: providerCredentials.failureCount,
            lastUsedAt: providerCredentials.lastUsedAt,
            lastErrorCode: providerCredentials.lastErrorCode,
            lastErrorMessage: providerCredentials.lastErrorMessage,
            isActive: providerCredentials.isActive,
            rotatedAt: providerCredentials.rotatedAt,
            revokedAt: providerCredentials.revokedAt,
            createdAt: providerCredentials.createdAt,
          })
          .from(providerCredentials)
          .innerJoin(aiProviders, eq(providerCredentials.providerId, aiProviders.id))
          .orderBy(asc(providerCredentials.priority), desc(providerCredentials.createdAt)),
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
          .set({ isActive: false, status: 'disabled', revokedAt: now, updatedAt: now })
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
