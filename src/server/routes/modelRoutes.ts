import { Router, type Response } from 'express';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { aiModels, aiProviders, modelCapabilities } from '../../db/schema.ts';
import { modelCreateSchema, modelUpdateSchema } from '../../shared/validation.ts';
import { recordAuditLog } from '../security/audit.ts';
import {
  getClientIp,
  requireAdminAuth,
  requireRole,
  type AdminRequest,
} from '../middleware/auth.ts';
import { getSystemBillingSettings } from '../services/walletService.ts';

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
        .select({ id: aiProviders.id, name: aiProviders.name })
        .from(aiProviders)
        .where(eq(aiProviders.id, data.providerId))
        .limit(1);

      if (!provider) {
        res.status(400).json({ error: 'ارائه‌دهنده انتخاب‌شده وجود ندارد.' });
        return;
      }

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
            modelIdentifier: data.modelIdentifier,
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
        if (data.modelIdentifier !== undefined) updatePayload.modelIdentifier = data.modelIdentifier;
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

  return router;
}
