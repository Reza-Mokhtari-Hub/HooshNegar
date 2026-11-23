import { Router, type Response } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/index.ts';
import { aiModels, aiProviders, modelCapabilities } from '../../db/schema.ts';
import { MODEL_CATEGORIES, modelCreateSchema, modelUpdateSchema } from '../../shared/validation.ts';
import { recordAuditLog } from '../security/audit.ts';
import {
  getClientIp,
  requireAdminAuth,
  requireRole,
  type AdminRequest,
} from '../middleware/auth.ts';
import { getSystemBillingSettings } from '../services/walletService.ts';
import { normalizeModelIdentifierForProvider } from '../providers/discovery.ts';
import {
  applyBulkModelAction,
  runBatchModelHealthCheck,
} from '../providers/modelHealthService.ts';

const modelHealthCheckSchema = z.object({
  providerId: z.string().uuid().optional(),
  category: z.enum(MODEL_CATEGORIES).optional(),
  modelIds: z.array(z.string().uuid()).max(50).optional(),
  onlyActive: z.boolean().optional().default(true),
  offset: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(20).optional().default(8),
  action: z
    .enum(['report_only', 'deactivate_broken', 'delete_broken'])
    .optional()
    .default('report_only'),
});

const bulkModelActionSchema = z.object({
  modelIds: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(['activate', 'deactivate', 'delete']),
});

export function createModelRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);

  router.get('/models', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [models, caps, billingSettings] = await Promise.all([
        db
          .select({
            id: aiModels.id,
            providerId: aiModels.providerId,
            providerName: aiProviders.name,
            providerType: aiProviders.providerType,
            providerActive: aiProviders.isActive,
            name: aiModels.name,
            modelIdentifier: aiModels.modelIdentifier,
            category: aiModels.category,
            description: aiModels.description,
            inputPricePerMillion: aiModels.inputPricePerMillion,
            outputPricePerMillion: aiModels.outputPricePerMillion,
            creditCost: aiModels.creditCost,
            minCreditCost: aiModels.minCreditCost,
            providerCostPerOpUsd: aiModels.providerCostPerOpUsd,
            allowedPlanTiers: aiModels.allowedPlanTiers,
            priority: aiModels.priority,
            isDefault: aiModels.isDefault,
            isActive: aiModels.isActive,
            maxInputSize: aiModels.maxInputSize,
            maxOutputSize: aiModels.maxOutputSize,
            fallbackProviderId: aiModels.fallbackProviderId,
            fallbackModelIdentifier: aiModels.fallbackModelIdentifier,
            modelParameters: aiModels.modelParameters,
            createdAt: aiModels.createdAt,
            updatedAt: aiModels.updatedAt,
          })
          .from(aiModels)
          .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
          .orderBy(aiModels.priority, desc(aiModels.createdAt)),
        db.select().from(modelCapabilities),
        getSystemBillingSettings(),
      ]);

      const capsByModel = new Map<string, string[]>();
      for (const c of caps) {
        const list = capsByModel.get(c.modelId) ?? [];
        list.push(c.capability);
        capsByModel.set(c.modelId, list);
      }

      res.json({
        creditValueUsd: billingSettings.creditValueUsd,
        models: models.map((m) => {
          const effectiveCredits = Math.max(Number(m.creditCost), Number(m.minCreditCost ?? 0));
          const providerCostUsd = Number(m.providerCostPerOpUsd ?? 0);
          const estRevenueUsd = Number((effectiveCredits * billingSettings.creditValueUsd).toFixed(6));
          const estProfitUsd = Number((estRevenueUsd - providerCostUsd).toFixed(6));
          return {
            ...m,
            inputPricePerMillion: Number(m.inputPricePerMillion),
            outputPricePerMillion: Number(m.outputPricePerMillion),
            creditCost: Number(m.creditCost),
            minCreditCost: Number(m.minCreditCost ?? 0),
            providerCostPerOpUsd: providerCostUsd,
            allowedPlanTiers: m.allowedPlanTiers ?? [],
            estimatedRevenuePerOpUsd: estRevenueUsd,
            estimatedProfitPerOpUsd: estProfitUsd,
            capabilities: capsByModel.get(m.id) ?? [],
          };
        }),
      });
    } catch (err) {
      console.error('[models/list]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت فهرست مدل‌های هوش مصنوعی.' });
    }
  });

  router.post('/models', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = modelCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message ?? 'اطلاعات مدل نامعتبر است.',
          issues: parsed.error.issues,
        });
        return;
      }

      const data = parsed.data;
      const db = getDb();

      // Verify provider exists
      const [provider] = await db
        .select({
          id: aiProviders.id,
          name: aiProviders.name,
          providerType: aiProviders.providerType,
        })
        .from(aiProviders)
        .where(eq(aiProviders.id, data.providerId))
        .limit(1);

      if (!provider) {
        res.status(400).json({ error: 'ارائه‌دهنده انتخاب‌شده وجود ندارد.' });
        return;
      }

      const normalizedModelIdentifier = normalizeModelIdentifierForProvider(
        provider.providerType,
        data.modelIdentifier,
      );
      const uniqueCaps = Array.from(new Set(data.capabilities));

      const created = await db.transaction(async (tx) => {
        if (data.isDefault) {
          await tx
            .update(aiModels)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(eq(aiModels.category, data.category));
        }

        const [model] = await tx
          .insert(aiModels)
          .values({
            providerId: data.providerId,
            name: data.name,
            modelIdentifier: normalizedModelIdentifier,
            category: data.category,
            description: data.description,
            inputPricePerMillion: String(data.inputPricePerMillion),
            outputPricePerMillion: String(data.outputPricePerMillion),
            creditCost: String(data.creditCost),
            minCreditCost: String(data.minCreditCost ?? 0),
            providerCostPerOpUsd: String(data.providerCostPerOpUsd ?? 0),
            allowedPlanTiers: data.allowedPlanTiers ?? [],
            priority: data.priority,
            isDefault: data.isDefault,
            isActive: data.isActive,
            maxInputSize: data.maxInputSize,
            maxOutputSize: data.maxOutputSize,
            fallbackProviderId: data.fallbackProviderId || null,
            fallbackModelIdentifier: data.fallbackModelIdentifier || null,
            modelParameters: data.modelParameters ?? {},
          })
          .returning();

        if (!model) throw new Error('Failed to create model');

        await tx.insert(modelCapabilities).values(
          uniqueCaps.map((capability) => ({
            modelId: model.id,
            capability,
          })),
        );

        return model;
      });

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'model.created',
        resourceType: 'ai_model',
        resourceId: created.id,
        ipAddress: ip,
        userAgent: ua,
        details: {
          name: created.name,
          modelIdentifier: created.modelIdentifier,
          providerName: provider.name,
          capabilities: uniqueCaps,
        },
      });

      res.status(201).json({
        model: {
          ...created,
          providerName: provider.name,
          inputPricePerMillion: Number(created.inputPricePerMillion),
          outputPricePerMillion: Number(created.outputPricePerMillion),
          creditCost: Number(created.creditCost),
          capabilities: uniqueCaps,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        res.status(409).json({ error: 'مدلی با این شناسه قبلاً برای این ارائه‌دهنده ثبت شده است.' });
        return;
      }
      console.error('[models/create]', msg);
      res.status(500).json({ error: 'خطا در ایجاد مدل هوش مصنوعی.' });
    }
  });

  router.patch('/models/:id', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = modelUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'اطلاعات نامعتبر است.' });
        return;
      }

      const data = parsed.data;
      const db = getDb();

      const updated = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(aiModels).where(eq(aiModels.id, id)).limit(1);
        if (!existing) return null;

        const targetCategory = data.category ?? existing.category;
        if (data.isDefault) {
          await tx
            .update(aiModels)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(eq(aiModels.category, targetCategory));
        }

        const updatePayload: Partial<typeof aiModels.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (data.providerId !== undefined) updatePayload.providerId = data.providerId;
        if (data.name !== undefined) updatePayload.name = data.name;
        if (data.modelIdentifier !== undefined) {
          const targetProviderId = data.providerId ?? existing.providerId;
          const [targetProv] = await tx
            .select({ providerType: aiProviders.providerType })
            .from(aiProviders)
            .where(eq(aiProviders.id, targetProviderId))
            .limit(1);
          updatePayload.modelIdentifier = targetProv
            ? normalizeModelIdentifierForProvider(targetProv.providerType, data.modelIdentifier)
            : data.modelIdentifier;
        }
        if (data.category !== undefined) updatePayload.category = data.category;
        if (data.description !== undefined) updatePayload.description = data.description;
        if (data.inputPricePerMillion !== undefined)
          updatePayload.inputPricePerMillion = String(data.inputPricePerMillion);
        if (data.outputPricePerMillion !== undefined)
          updatePayload.outputPricePerMillion = String(data.outputPricePerMillion);
        if (data.creditCost !== undefined) updatePayload.creditCost = String(data.creditCost);
        if (data.minCreditCost !== undefined) updatePayload.minCreditCost = String(data.minCreditCost);
        if (data.providerCostPerOpUsd !== undefined)
          updatePayload.providerCostPerOpUsd = String(data.providerCostPerOpUsd);
        if (data.allowedPlanTiers !== undefined)
          updatePayload.allowedPlanTiers = data.allowedPlanTiers;
        if (data.priority !== undefined) updatePayload.priority = data.priority;
        if (data.isDefault !== undefined) updatePayload.isDefault = data.isDefault;
        if (data.isActive !== undefined) updatePayload.isActive = data.isActive;
        if (data.maxInputSize !== undefined) updatePayload.maxInputSize = data.maxInputSize;
        if (data.maxOutputSize !== undefined) updatePayload.maxOutputSize = data.maxOutputSize;
        if (data.fallbackProviderId !== undefined)
          updatePayload.fallbackProviderId = data.fallbackProviderId || null;
        if (data.fallbackModelIdentifier !== undefined)
          updatePayload.fallbackModelIdentifier = data.fallbackModelIdentifier || null;
        if (data.modelParameters !== undefined) updatePayload.modelParameters = data.modelParameters;

        const [saved] = await tx
          .update(aiModels)
          .set(updatePayload)
          .where(eq(aiModels.id, id))
          .returning();

        if (data.capabilities && data.capabilities.length > 0) {
          const uniqueCaps = Array.from(new Set(data.capabilities));
          await tx.delete(modelCapabilities).where(eq(modelCapabilities.modelId, id));
          await tx.insert(modelCapabilities).values(
            uniqueCaps.map((capability) => ({
              modelId: id,
              capability,
            })),
          );
        }

        return saved;
      });

      if (!updated) {
        res.status(404).json({ error: 'مدل مورد نظر یافت نشد.' });
        return;
      }

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'model.updated',
        resourceType: 'ai_model',
        resourceId: id,
        ipAddress: ip,
        userAgent: ua,
        details: { name: updated.name, isActive: updated.isActive, isDefault: updated.isDefault },
      });

      res.json({ model: updated });
    } catch (err) {
      console.error('[models/update]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در به‌روزرسانی مدل.' });
    }
  });

  router.delete('/models/:id', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const db = getDb();
      const [deleted] = await db
        .delete(aiModels)
        .where(eq(aiModels.id, id))
        .returning({ id: aiModels.id, name: aiModels.name, modelIdentifier: aiModels.modelIdentifier });

      if (!deleted) {
        res.status(404).json({ error: 'مدل یافت نشد.' });
        return;
      }

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'model.deleted',
        resourceType: 'ai_model',
        resourceId: deleted.id,
        severity: 'warning',
        ipAddress: ip,
        userAgent: ua,
        details: { name: deleted.name, modelIdentifier: deleted.modelIdentifier },
      });

      res.json({ ok: true, id: deleted.id });
    } catch (err) {
      console.error('[models/delete]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در حذف مدل.' });
    }
  });

  router.post(
    '/models/health-check',
    requireRole('operator'),
    async (req: AdminRequest, res: Response) => {
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const parsed = modelHealthCheckSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            error: parsed.error.issues[0]?.message ?? 'پارامترهای بررسی سلامت مدل‌ها نامعتبر است.',
          });
          return;
        }

        const data = parsed.data;
        // Deleting or deactivating models requires admin or super_admin role
        if (
          data.action !== 'report_only' &&
          req.admin?.role !== 'admin' &&
          req.admin?.role !== 'super_admin'
        ) {
          res.status(403).json({
            error: 'برای غیرفعال‌سازی یا حذف مدل‌های خراب به دسترسی مدیر (admin) نیاز است.',
          });
          return;
        }

        const report = await runBatchModelHealthCheck({
          providerId: data.providerId,
          category: data.category,
          modelIds: data.modelIds,
          onlyActive: data.onlyActive,
          offset: data.offset,
          limit: data.limit,
          action: data.action,
        });

        if (
          data.action !== 'report_only' &&
          (report.summary.deactivated > 0 || report.summary.deleted > 0)
        ) {
          await recordAuditLog({
            adminUserId: req.admin!.id,
            actorEmail: req.admin!.email,
            action:
              data.action === 'delete_broken'
                ? 'model.health_prune_deleted'
                : 'model.health_prune_deactivated',
            resourceType: 'ai_model',
            severity: data.action === 'delete_broken' ? 'warning' : 'info',
            ipAddress: ip,
            userAgent: ua,
            details: {
              providerId: data.providerId ?? 'all',
              category: data.category ?? 'all',
              summary: report.summary,
            },
          });
        }

        res.json(report);
      } catch (err) {
        console.error('[models/health-check]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در اجرای بررسی سلامت مدل‌ها.' });
      }
    },
  );

  // Manual bulk enable / disable / delete for arbitrary models (broken, rate-limited, inactive, etc.)
  router.post(
    '/models/bulk-action',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      try {
        const parsed = bulkModelActionSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            error: 'ورودی عملیات گروهی مدل‌ها معتبر نیست.',
            details: parsed.error.flatten(),
          });
          return;
        }

        const { modelIds, action } = parsed.data;
        const result = await applyBulkModelAction({ modelIds, action });

        if (result.affectedCount > 0) {
          const ip = getClientIp(req);
          const ua = req.headers['user-agent'] ?? null;
          const auditAction =
            action === 'activate'
              ? 'model.bulk_activated'
              : action === 'deactivate'
                ? 'model.bulk_deactivated'
                : 'model.bulk_deleted';

          await recordAuditLog({
            adminUserId: req.admin!.id,
            action: auditAction,
            resourceType: 'ai_model',
            severity: action === 'delete' ? 'warning' : 'info',
            ipAddress: ip,
            userAgent: ua,
            details: {
              action,
              affectedCount: result.affectedCount,
              modelIds: result.affectedIds.slice(0, 50),
            },
          });
        }

        res.json(result);
      } catch (err) {
        console.error('[models/bulk-action]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در اعمال عملیات دستی روی مدل‌ها.' });
      }
    },
  );

  return router;
}
