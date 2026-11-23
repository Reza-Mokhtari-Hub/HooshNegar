import crypto from 'node:crypto';
import { and, asc, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiProviders,
  aiRequests,
  coupons,
  creditPackages,
  creditWallets,
  generationJobs,
  providerCredentials,
  subscriptionPlans,
  telegramAccounts,
  telegramBotSettings,
  userProfiles,
  users,
  userSubscriptions,
} from '../../db/schema.ts';
import type { ModelCategory } from '../../shared/validation.ts';
import { isAiMockModeEnabled } from '../config/env.ts';
import { generateTextWithRoute, loadModelExecutionRoute } from '../providers/engine.ts';
import { runBatchModelHealthCheck } from '../providers/modelHealthService.ts';
import { recordAuditLog } from '../security/audit.ts';
import { reapStaleRunningJobs } from './maintenanceService.ts';
import { applyWalletCreditChange } from './walletService.ts';

export type CopilotWriteToolName =
  | 'update_plan'
  | 'update_model'
  | 'bulk_update_models'
  | 'prune_broken_models'
  | 'adjust_user_credits'
  | 'recover_stuck_jobs'
  | 'create_coupon'
  | 'update_bot_messages';

export type CopilotReadToolName =
  | 'get_platform_overview'
  | 'list_providers'
  | 'list_models'
  | 'inspect_failed_requests'
  | 'list_plans_and_packages'
  | 'search_users'
  | 'list_generation_jobs';

export interface CopilotToolTrace {
  tool: CopilotReadToolName;
  labelFa: string;
  args: Record<string, unknown>;
  summaryFa: string;
  durationMs: number;
}

export interface CopilotProposedAction {
  id: string;
  tool: CopilotWriteToolName;
  titleFa: string;
  descriptionFa: string;
  risk: 'low' | 'medium' | 'high';
  args: Record<string, unknown>;
}

export interface CopilotActionExecutionResult {
  actionId: string;
  tool: CopilotWriteToolName;
  ok: boolean;
  summaryFa: string;
  details?: Record<string, unknown>;
}

export interface CopilotChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CopilotAdminActor {
  id: string;
  email: string;
  role: 'super_admin' | 'admin' | 'operator' | 'auditor';
  ipAddress?: string;
  userAgent?: string;
}

export interface CopilotChatResponse {
  replyFa: string;
  usedModelId: string | null;
  usedModelName: string;
  toolTraces: CopilotToolTrace[];
  proposedActions: CopilotProposedAction[];
  executedActions: CopilotActionExecutionResult[];
}

export interface CopilotContextResponse {
  availableModels: Array<{
    id: string;
    name: string;
    modelIdentifier: string;
    providerName: string;
    providerType: string;
    isDefault: boolean;
  }>;
  recommendedModelId: string | null;
  alerts: {
    totalUsers: number;
    activeProviders: number;
    activeModels: number;
    inactiveModels: number;
    failedRequests24h: number;
    stuckJobs: number;
    freePlanCredits: number | null;
  };
}

const READ_TOOL_LABELS_FA: Record<CopilotReadToolName, string> = {
  get_platform_overview: 'بررسی شاخص‌های کلیدی سامانه',
  list_providers: 'بررسی وضعیت ارائه‌دهندگان و کلیدهای API',
  list_models: 'بررسی فهرست مدل‌های هوش مصنوعی',
  inspect_failed_requests: 'تحلیل خطاها و درخواست‌های ناموفق اخیر',
  list_plans_and_packages: 'بررسی پلن‌های اشتراک و بسته‌های اعتبار',
  search_users: 'جستجو در فهرست کاربران و کیف پول‌ها',
  list_generation_jobs: 'بررسی وضعیت صف پردازش و تسک‌های جاری',
};

const VALID_WRITE_TOOLS = new Set<CopilotWriteToolName>([
  'update_plan',
  'update_model',
  'bulk_update_models',
  'prune_broken_models',
  'adjust_user_credits',
  'recover_stuck_jobs',
  'create_coupon',
  'update_bot_messages',
]);

const VALID_READ_TOOLS = new Set<CopilotReadToolName>([
  'get_platform_overview',
  'list_providers',
  'list_models',
  'inspect_failed_requests',
  'list_plans_and_packages',
  'search_users',
  'list_generation_jobs',
]);

// =============================================================================
// LIVE CONTEXT & READ TOOLS
// =============================================================================

export async function getAdminCopilotContext(): Promise<CopilotContextResponse> {
  const db = getDb();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const stuckCutoff = new Date(Date.now() - 2 * 60 * 1000);

  const [
    chatModelRows,
    userCountRow,
    providerCountRow,
    modelCountsRow,
    failed24hRow,
    stuckJobsRow,
    freePlanRow,
  ] = await Promise.all([
    db
      .select({
        id: aiModels.id,
        name: aiModels.name,
        modelIdentifier: aiModels.modelIdentifier,
        providerName: aiProviders.name,
        providerType: aiProviders.providerType,
        isDefault: aiModels.isDefault,
        priority: aiModels.priority,
        category: aiModels.category,
      })
      .from(aiModels)
      .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
      .where(
        and(
          eq(aiModels.isActive, true),
          eq(aiProviders.isActive, true),
          inArray(aiModels.category, ['llm', 'multimodal']),
        ),
      )
      .orderBy(desc(aiModels.isDefault), asc(aiModels.priority)),
    db.select({ count: sql<number>`count(*)::int` }).from(users),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiProviders)
      .where(eq(aiProviders.isActive, true)),
    db
      .select({
        active: sql<number>`count(*) filter (where ${aiModels.isActive} = true)::int`,
        inactive: sql<number>`count(*) filter (where ${aiModels.isActive} = false)::int`,
      })
      .from(aiModels),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiRequests)
      .where(and(eq(aiRequests.status, 'failed'), gte(aiRequests.createdAt, since24h))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(generationJobs)
      .where(
        and(
          inArray(generationJobs.status, ['queued', 'running']),
          sql`${generationJobs.updatedAt} < ${stuckCutoff}`,
        ),
      ),
    db
      .select({ creditAllocation: subscriptionPlans.creditAllocation })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.tier, 'free'))
      .orderBy(asc(subscriptionPlans.sortOrder))
      .limit(1),
  ]);

  const availableModels = chatModelRows.slice(0, 40).map((m) => ({
    id: m.id,
    name: m.name,
    modelIdentifier: m.modelIdentifier,
    providerName: m.providerName,
    providerType: m.providerType,
    isDefault: m.isDefault,
  }));

  const recommended =
    availableModels.find((m) => m.isDefault) ?? availableModels[0] ?? null;

  return {
    availableModels,
    recommendedModelId: recommended?.id ?? null,
    alerts: {
      totalUsers: Number(userCountRow[0]?.count ?? 0),
      activeProviders: Number(providerCountRow[0]?.count ?? 0),
      activeModels: Number(modelCountsRow[0]?.active ?? 0),
      inactiveModels: Number(modelCountsRow[0]?.inactive ?? 0),
      failedRequests24h: Number(failed24hRow[0]?.count ?? 0),
      stuckJobs: Number(stuckJobsRow[0]?.count ?? 0),
      freePlanCredits: freePlanRow[0] ? Number(freePlanRow[0].creditAllocation) : null,
    },
  };
}

export async function runReadTool(
  tool: CopilotReadToolName,
  args: Record<string, unknown>,
): Promise<{ data: unknown; summaryFa: string }> {
  const db = getDb();

  switch (tool) {
    case 'get_platform_overview': {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [
        usersRow,
        activeSubsRow,
        reqStatsRow,
        providersRow,
        modelsRow,
        stuckRow,
      ] = await Promise.all([
        db.select({ total: sql<number>`count(*)::int` }).from(users),
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(userSubscriptions)
          .where(eq(userSubscriptions.status, 'active')),
        db
          .select({
            total: sql<number>`count(*)::int`,
            succeeded: sql<number>`count(*) filter (where ${aiRequests.status} = 'succeeded')::int`,
            failed: sql<number>`count(*) filter (where ${aiRequests.status} = 'failed')::int`,
          })
          .from(aiRequests)
          .where(gte(aiRequests.createdAt, since24h)),
        db
          .select({
            total: sql<number>`count(*)::int`,
            active: sql<number>`count(*) filter (where ${aiProviders.isActive} = true)::int`,
          })
          .from(aiProviders),
        db
          .select({
            total: sql<number>`count(*)::int`,
            active: sql<number>`count(*) filter (where ${aiModels.isActive} = true)::int`,
          })
          .from(aiModels),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(generationJobs)
          .where(inArray(generationJobs.status, ['queued', 'running'])),
      ]);

      const overview = {
        totalUsers: Number(usersRow[0]?.total ?? 0),
        activeSubscriptions: Number(activeSubsRow[0]?.total ?? 0),
        requests24h: {
          total: Number(reqStatsRow[0]?.total ?? 0),
          succeeded: Number(reqStatsRow[0]?.succeeded ?? 0),
          failed: Number(reqStatsRow[0]?.failed ?? 0),
        },
        providers: {
          total: Number(providersRow[0]?.total ?? 0),
          active: Number(providersRow[0]?.active ?? 0),
        },
        models: {
          total: Number(modelsRow[0]?.total ?? 0),
          active: Number(modelsRow[0]?.active ?? 0),
        },
        activeOrQueuedJobs: Number(stuckRow[0]?.count ?? 0),
      };

      return {
        data: overview,
        summaryFa: `${overview.totalUsers} کاربر، ${overview.models.active} مدل فعال، ${overview.requests24h.failed} خطا در ۲۴ ساعت اخیر`,
      };
    }

    case 'list_providers': {
      const [providers, creds, models] = await Promise.all([
        db.select().from(aiProviders).orderBy(asc(aiProviders.priority)),
        db
          .select({
            providerId: providerCredentials.providerId,
            status: providerCredentials.status,
            isActive: providerCredentials.isActive,
          })
          .from(providerCredentials),
        db
          .select({
            providerId: aiModels.providerId,
            isActive: aiModels.isActive,
          })
          .from(aiModels),
      ]);

      const rows = providers.map((p) => {
        const pCreds = creds.filter((c) => c.providerId === p.id && c.isActive);
        const pModels = models.filter((m) => m.providerId === p.id);
        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          providerType: p.providerType,
          isActive: p.isActive,
          connectionStatus: p.connectionStatus,
          lastTestMessage: p.lastTestMessage,
          activeKeysCount: pCreds.length,
          healthyKeysCount: pCreds.filter((c) => c.status === 'active').length,
          totalModels: pModels.length,
          activeModels: pModels.filter((m) => m.isActive).length,
        };
      });

      return {
        data: rows,
        summaryFa: `${rows.length} ارائه‌دهنده بررسی شد`,
      };
    }

    case 'list_models': {
      const providerId = typeof args.providerId === 'string' ? args.providerId : undefined;
      const category = typeof args.category === 'string' ? (args.category as ModelCategory) : undefined;
      const isActive = typeof args.isActive === 'boolean' ? args.isActive : undefined;
      const search = typeof args.search === 'string' ? args.search.trim() : '';

      const conds = [];
      if (providerId) conds.push(eq(aiModels.providerId, providerId));
      if (category) conds.push(eq(aiModels.category, category));
      if (isActive !== undefined) conds.push(eq(aiModels.isActive, isActive));
      if (search) {
        const pattern = `%${search}%`;
        conds.push(or(ilike(aiModels.name, pattern), ilike(aiModels.modelIdentifier, pattern)));
      }

      const rows = await db
        .select({
          id: aiModels.id,
          name: aiModels.name,
          modelIdentifier: aiModels.modelIdentifier,
          category: aiModels.category,
          providerId: aiModels.providerId,
          providerName: aiProviders.name,
          creditCost: aiModels.creditCost,
          priority: aiModels.priority,
          isActive: aiModels.isActive,
          isDefault: aiModels.isDefault,
        })
        .from(aiModels)
        .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(asc(aiModels.priority), desc(aiModels.createdAt))
        .limit(50);

      const formatted = rows.map((r) => ({
        ...r,
        creditCost: Number(r.creditCost),
      }));

      return {
        data: formatted,
        summaryFa: `${formatted.length} مدل یافت شد`,
      };
    }

    case 'inspect_failed_requests': {
      const limit = Math.min(20, Math.max(5, Number(args.limit ?? 15)));
      const rows = await db
        .select({
          id: aiRequests.id,
          modelId: aiRequests.modelId,
          modelName: aiModels.name,
          modelIdentifier: aiModels.modelIdentifier,
          providerName: aiProviders.name,
          capability: aiRequests.capability,
          errorCode: aiRequests.errorCode,
          errorMessage: aiRequests.errorMessage,
          createdAt: aiRequests.createdAt,
        })
        .from(aiRequests)
        .leftJoin(aiModels, eq(aiRequests.modelId, aiModels.id))
        .leftJoin(aiProviders, eq(aiRequests.providerId, aiProviders.id))
        .where(eq(aiRequests.status, 'failed'))
        .orderBy(desc(aiRequests.createdAt))
        .limit(limit);

      const countsByModel = new Map<string, { modelId: string | null; modelName: string; count: number }>();
      for (const r of rows) {
        const key = r.modelId ?? 'unknown';
        const curr = countsByModel.get(key) ?? {
          modelId: r.modelId,
          modelName: r.modelName ?? 'نامشخص',
          count: 0,
        };
        curr.count += 1;
        countsByModel.set(key, curr);
      }

      return {
        data: {
          topFailingModels: Array.from(countsByModel.values()).sort((a, b) => b.count - a.count),
          recentFailures: rows.map((r) => ({
            id: r.id,
            modelId: r.modelId,
            modelName: r.modelName,
            modelIdentifier: r.modelIdentifier,
            providerName: r.providerName,
            capability: r.capability,
            errorCode: r.errorCode,
            errorMessage: (r.errorMessage ?? '').slice(0, 220),
            createdAt: r.createdAt,
          })),
        },
        summaryFa: `${rows.length} درخواست ناموفق اخیر تحلیل شد`,
      };
    }

    case 'list_plans_and_packages': {
      const [plans, packages] = await Promise.all([
        db.select().from(subscriptionPlans).orderBy(asc(subscriptionPlans.sortOrder)),
        db.select().from(creditPackages).orderBy(asc(creditPackages.sortOrder)),
      ]);

      return {
        data: {
          plans: plans.map((p) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            tier: p.tier,
            creditAllocation: p.creditAllocation,
            starsPrice: p.starsPrice,
            priceAmount: Number(p.priceAmount),
            dailyRequestLimit: p.dailyRequestLimit,
            dailyImageLimit: p.dailyImageLimit,
            durationDays: p.durationDays,
            isEnabled: p.isEnabled,
          })),
          packages: packages.map((pkg) => ({
            id: pkg.id,
            name: pkg.name,
            slug: pkg.slug,
            creditsAmount: pkg.creditsAmount,
            bonusCredits: pkg.bonusCredits,
            starsPrice: pkg.starsPrice,
            isActive: pkg.isActive,
          })),
        },
        summaryFa: `${plans.length} پلن اشتراک و ${packages.length} بسته اعتبار خوانده شد`,
      };
    }

    case 'search_users': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const pattern = query ? `%${query}%` : '%';
      const rows = await db
        .select({
          id: users.id,
          status: users.status,
          displayName: userProfiles.displayName,
          username: telegramAccounts.username,
          telegramUserId: telegramAccounts.telegramUserId,
          balance: creditWallets.balance,
          createdAt: users.createdAt,
        })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .leftJoin(telegramAccounts, eq(telegramAccounts.userId, users.id))
        .leftJoin(creditWallets, eq(creditWallets.userId, users.id))
        .where(
          query
            ? or(
                ilike(userProfiles.displayName, pattern),
                ilike(telegramAccounts.username, pattern),
                sql`cast(${telegramAccounts.telegramUserId} as text) ilike ${pattern}`,
              )
            : undefined,
        )
        .orderBy(desc(users.createdAt))
        .limit(20);

      return {
        data: rows.map((u) => ({
          id: u.id,
          displayName: u.displayName,
          username: u.username,
          telegramUserId: u.telegramUserId,
          status: u.status,
          balance: Number(u.balance ?? 0),
        })),
        summaryFa: `${rows.length} کاربر یافت شد`,
      };
    }

    case 'list_generation_jobs': {
      const onlyActive = args.onlyActive === true;
      const rows = await db
        .select({
          id: generationJobs.id,
          requestId: generationJobs.requestId,
          capability: generationJobs.capability,
          status: generationJobs.status,
          progressPercent: generationJobs.progressPercent,
          errorMessage: generationJobs.errorMessage,
          updatedAt: generationJobs.updatedAt,
          createdAt: generationJobs.createdAt,
        })
        .from(generationJobs)
        .where(onlyActive ? inArray(generationJobs.status, ['queued', 'running']) : undefined)
        .orderBy(desc(generationJobs.createdAt))
        .limit(25);

      return {
        data: rows,
        summaryFa: `${rows.length} تسک تولید رسانه بررسی شد`,
      };
    }
  }
}

// =============================================================================
// WRITE ACTION EXECUTOR (RBAC + AUDIT LOGGED)
// =============================================================================

export async function executeAdminCopilotAction(params: {
  actor: CopilotAdminActor;
  actionId: string;
  tool: CopilotWriteToolName;
  args: Record<string, unknown>;
}): Promise<CopilotActionExecutionResult> {
  const { actor, actionId, tool, args } = params;

  if (!VALID_WRITE_TOOLS.has(tool)) {
    return {
      actionId,
      tool,
      ok: false,
      summaryFa: 'ابزار درخواستی مجاز نیست.',
    };
  }

  // RBAC: operators may recover stuck jobs; all other mutations require admin or super_admin
  const isAdminOrHigher = actor.role === 'admin' || actor.role === 'super_admin';
  if (tool !== 'recover_stuck_jobs' && !isAdminOrHigher) {
    return {
      actionId,
      tool,
      ok: false,
      summaryFa: 'برای اجرای این عملیات مدیریتی دسترسی مدیر (admin) لازم است.',
    };
  }
  if (actor.role === 'auditor') {
    return {
      actionId,
      tool,
      ok: false,
      summaryFa: 'نقش بازرس (auditor) مجاز به اجرای تغییرات نیست.',
    };
  }

  const db = getDb();

  try {
    switch (tool) {
      case 'update_plan': {
        const planId = typeof args.planId === 'string' ? args.planId.trim() : '';
        const planSlug = typeof args.planSlug === 'string' ? args.planSlug.trim() : '';

        const [existing] = planId
          ? await db
              .select()
              .from(subscriptionPlans)
              .where(eq(subscriptionPlans.id, planId))
              .limit(1)
          : planSlug
            ? await db
                .select()
                .from(subscriptionPlans)
                .where(
                  or(
                    eq(subscriptionPlans.slug, planSlug),
                    eq(subscriptionPlans.tier, planSlug as typeof subscriptionPlans.$inferSelect.tier),
                  ),
                )
                .limit(1)
            : [];

        if (!existing) {
          return {
            actionId,
            tool,
            ok: false,
            summaryFa: 'پلن اشتراک مورد نظر پیدا نشد.',
          };
        }

        const patch: Partial<typeof subscriptionPlans.$inferInsert> = {
          updatedAt: new Date(),
        };
        const changes: string[] = [];

        if (typeof args.name === 'string' && args.name.trim()) {
          patch.name = args.name.trim().slice(0, 120);
          changes.push(`نام ← ${patch.name}`);
        }
        if (typeof args.creditAllocation === 'number' && Number.isFinite(args.creditAllocation) && args.creditAllocation >= 0) {
          patch.creditAllocation = Math.round(args.creditAllocation);
          changes.push(`اعتبار ← ${patch.creditAllocation}`);
        }
        if (typeof args.starsPrice === 'number' && Number.isFinite(args.starsPrice) && args.starsPrice >= 0) {
          patch.starsPrice = Math.round(args.starsPrice);
          patch.priceAmount = String(Math.round(args.starsPrice));
          changes.push(`قیمت استارز ← ${patch.starsPrice}`);
        }
        if (typeof args.dailyRequestLimit === 'number' && Number.isFinite(args.dailyRequestLimit) && args.dailyRequestLimit >= 0) {
          patch.dailyRequestLimit = Math.round(args.dailyRequestLimit);
          changes.push(`سقف روزانه ← ${patch.dailyRequestLimit}`);
        }
        if (typeof args.dailyImageLimit === 'number' && Number.isFinite(args.dailyImageLimit) && args.dailyImageLimit >= 0) {
          patch.dailyImageLimit = Math.round(args.dailyImageLimit);
          changes.push(`سقف تصویر روزانه ← ${patch.dailyImageLimit}`);
        }
        if (typeof args.isEnabled === 'boolean') {
          patch.isEnabled = args.isEnabled;
          changes.push(`وضعیت ← ${args.isEnabled ? 'فعال' : 'غیرفعال'}`);
        }

        if (changes.length === 0) {
          return {
            actionId,
            tool,
            ok: false,
            summaryFa: 'هیچ فیلد معتبری برای ویرایش پلن ارسال نشد.',
          };
        }

        const [updated] = await db
          .update(subscriptionPlans)
          .set(patch)
          .where(eq(subscriptionPlans.id, existing.id))
          .returning();

        await recordAuditLog({
          adminUserId: actor.id,
          actorEmail: actor.email,
          action: 'ai_copilot.update_plan',
          resourceType: 'subscription_plan',
          resourceId: existing.id,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          details: { planName: existing.name, changes },
        });

        return {
          actionId,
          tool,
          ok: true,
          summaryFa: `پلن «${updated!.name}» با موفقیت به‌روزرسانی شد (${changes.join('، ')}).`,
          details: { planId: existing.id, changes },
        };
      }

      case 'update_model': {
        const modelId = typeof args.modelId === 'string' ? args.modelId.trim() : '';
        if (!modelId) {
          return { actionId, tool, ok: false, summaryFa: 'شناسه مدل مشخص نشده است.' };
        }

        const [existing] = await db
          .select()
          .from(aiModels)
          .where(eq(aiModels.id, modelId))
          .limit(1);

        if (!existing) {
          return { actionId, tool, ok: false, summaryFa: 'مدل مورد نظر یافت نشد.' };
        }

        const patch: Partial<typeof aiModels.$inferInsert> = { updatedAt: new Date() };
        const changes: string[] = [];

        if (typeof args.name === 'string' && args.name.trim()) {
          patch.name = args.name.trim().slice(0, 140);
          changes.push(`نام ← ${patch.name}`);
        }
        if (typeof args.creditCost === 'number' && Number.isFinite(args.creditCost) && args.creditCost >= 0) {
          patch.creditCost = String(args.creditCost);
          changes.push(`هزینه اعتبار ← ${args.creditCost}`);
        }
        if (typeof args.priority === 'number' && Number.isFinite(args.priority) && args.priority >= 0) {
          patch.priority = Math.round(args.priority);
          changes.push(`اولویت ← ${patch.priority}`);
        }
        if (typeof args.isActive === 'boolean') {
          patch.isActive = args.isActive;
          if (!args.isActive) patch.isDefault = false;
          changes.push(`وضعیت ← ${args.isActive ? 'فعال' : 'غیرفعال'}`);
        }
        if (typeof args.isDefault === 'boolean') {
          if (args.isDefault) {
            await db
              .update(aiModels)
              .set({ isDefault: false, updatedAt: new Date() })
              .where(eq(aiModels.category, existing.category));
          }
          patch.isDefault = args.isDefault;
          changes.push(`پیش‌فرض ← ${args.isDefault ? 'بله' : 'خیر'}`);
        }

        if (changes.length === 0) {
          return { actionId, tool, ok: false, summaryFa: 'تغییر معتبری برای مدل مشخص نشده است.' };
        }

        await db.update(aiModels).set(patch).where(eq(aiModels.id, existing.id));

        await recordAuditLog({
          adminUserId: actor.id,
          actorEmail: actor.email,
          action: 'ai_copilot.update_model',
          resourceType: 'ai_model',
          resourceId: existing.id,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          details: { modelName: existing.name, changes },
        });

        return {
          actionId,
          tool,
          ok: true,
          summaryFa: `مدل «${existing.name}» ویرایش شد (${changes.join('، ')}).`,
          details: { modelId: existing.id, changes },
        };
      }

      case 'bulk_update_models': {
        const providerId = typeof args.providerId === 'string' ? args.providerId.trim() : '';
        const category = typeof args.category === 'string' ? (args.category as ModelCategory) : undefined;
        const search = typeof args.search === 'string' ? args.search.trim() : '';

        if (!providerId && !category && !search) {
          return {
            actionId,
            tool,
            ok: false,
            summaryFa: 'برای تغییر گروهی حداقل باید ارائه‌دهنده، دسته یا عبارت جستجو مشخص شود.',
          };
        }

        const conds = [];
        if (providerId) conds.push(eq(aiModels.providerId, providerId));
        if (category) conds.push(eq(aiModels.category, category));
        if (search) {
          const pat = `%${search}%`;
          conds.push(or(ilike(aiModels.name, pat), ilike(aiModels.modelIdentifier, pat)));
        }

        const patch: Partial<typeof aiModels.$inferInsert> = { updatedAt: new Date() };
        const changes: string[] = [];
        if (typeof args.isActive === 'boolean') {
          patch.isActive = args.isActive;
          if (!args.isActive) patch.isDefault = false;
          changes.push(`وضعیت ← ${args.isActive ? 'فعال' : 'غیرفعال'}`);
        }
        if (typeof args.creditCost === 'number' && Number.isFinite(args.creditCost) && args.creditCost >= 0) {
          patch.creditCost = String(args.creditCost);
          changes.push(`هزینه اعتبار ← ${args.creditCost}`);
        }

        if (changes.length === 0) {
          return { actionId, tool, ok: false, summaryFa: 'هیچ تغییر معتبری برای اعمال گروهی مشخص نشده است.' };
        }

        const updatedRows = await db
          .update(aiModels)
          .set(patch)
          .where(and(...conds))
          .returning({ id: aiModels.id });

        await recordAuditLog({
          adminUserId: actor.id,
          actorEmail: actor.email,
          action: 'ai_copilot.bulk_update_models',
          resourceType: 'ai_model',
          severity: 'warning',
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          details: { providerId, category, search, affected: updatedRows.length, changes },
        });

        return {
          actionId,
          tool,
          ok: true,
          summaryFa: `${updatedRows.length} مدل به‌صورت گروهی به‌روزرسانی شد (${changes.join('، ')}).`,
          details: { affectedCount: updatedRows.length, changes },
        };
      }

      case 'prune_broken_models': {
        const providerId = typeof args.providerId === 'string' && args.providerId.trim() ? args.providerId.trim() : undefined;
        const category = typeof args.category === 'string' && args.category.trim() ? (args.category.trim() as ModelCategory) : undefined;
        const mode = args.mode === 'delete_broken' ? 'delete_broken' : 'deactivate_broken';

        let offset = 0;
        let hasMore = true;
        let rounds = 0;
        const totals = {
          processed: 0,
          healthy: 0,
          rateLimited: 0,
          broken: 0,
          deactivated: 0,
          deleted: 0,
        };

        // Process up to 3 batches (24 models) inside one copilot action so it stays well within Worker CPU limits
        while (hasMore && rounds < 3) {
          const batch = await runBatchModelHealthCheck({
            providerId,
            category,
            onlyActive: true,
            offset,
            limit: 8,
            action: mode,
          });
          totals.processed += batch.processedCount;
          totals.healthy += batch.summary.healthy;
          totals.rateLimited += batch.summary.rateLimited;
          totals.broken += batch.summary.broken;
          totals.deactivated += batch.summary.deactivated;
          totals.deleted += batch.summary.deleted;
          hasMore = batch.hasMore;
          offset = batch.nextOffset ?? 0;
          rounds += 1;
        }

        await recordAuditLog({
          adminUserId: actor.id,
          actorEmail: actor.email,
          action: 'ai_copilot.prune_broken_models',
          resourceType: 'ai_model',
          severity: mode === 'delete_broken' ? 'warning' : 'info',
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          details: { providerId: providerId ?? 'all', mode, totals, hasMore },
        });

        const moreHint = hasMore
          ? ' (برای بررسی بقیه مدل‌ها از دکمه «پالایش هوشمند مدل‌های سالم» در بخش مدل‌ها استفاده کنید.)'
          : '';

        return {
          actionId,
          tool,
          ok: true,
          summaryFa: `${totals.processed} مدل تست شد: ${totals.healthy} سالم، ${totals.rateLimited} لیمیت‌دار (حفظ شد)، ${totals.deactivated + totals.deleted} مدل خراب ${mode === 'delete_broken' ? 'حذف' : 'غیرفعال'} شد.${moreHint}`,
          details: { ...totals, hasMore },
        };
      }

      case 'adjust_user_credits': {
        const userId = typeof args.userId === 'string' ? args.userId.trim() : '';
        const amount = Number(args.amount);
        const reason =
          typeof args.reason === 'string' && args.reason.trim()
            ? args.reason.trim().slice(0, 200)
            : 'تنظیم اعتبار توسط دستیار هوشمند مدیریت';

        if (!userId || !Number.isFinite(amount) || amount === 0) {
          return { actionId, tool, ok: false, summaryFa: 'شناسه کاربر یا مقدار اعتبار نامعتبر است.' };
        }

        const res = await applyWalletCreditChange({
          userId,
          amount,
          type: amount > 0 ? 'grant' : 'adjustment',
          idempotencyKey: `copilot-adj-${actionId}-${crypto.randomUUID().slice(0, 8)}`,
          description: reason,
          adminUserId: actor.id,
          referenceType: 'ai_copilot',
        });

        await recordAuditLog({
          adminUserId: actor.id,
          actorEmail: actor.email,
          action: 'ai_copilot.adjust_user_credits',
          resourceType: 'credit_wallet',
          resourceId: userId,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          details: { userId, amount, reason, balanceAfter: res.balanceAfter },
        });

        return {
          actionId,
          tool,
          ok: true,
          summaryFa: `اعتبار کاربر ${amount > 0 ? `+${amount}` : amount} تغییر یافت. موجودی جدید: ${res.balanceAfter} اعتبار.`,
          details: { userId, balanceBefore: res.balanceBefore, balanceAfter: res.balanceAfter },
        };
      }

      case 'recover_stuck_jobs': {
        const maxAgeSeconds = Math.max(30, Math.min(3600, Number(args.maxAgeSeconds ?? 60)));
        const recovered = await reapStaleRunningJobs({
          maxAgeMs: maxAgeSeconds * 1000,
          videoMaxAgeMs: Math.max(maxAgeSeconds * 1000, 5 * 60 * 1000),
        });

        await recordAuditLog({
          adminUserId: actor.id,
          actorEmail: actor.email,
          action: 'ai_copilot.recover_stuck_jobs',
          resourceType: 'generation_job',
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          details: { maxAgeSeconds, recovered },
        });

        return {
          actionId,
          tool,
          ok: true,
          summaryFa:
            recovered > 0
              ? `${recovered} تسک متوقف‌شده پاک‌سازی شد و اعتبار رزرو کاربران بازگشت داده شد.`
              : 'هیچ تسک متوقف‌شده‌ای برای پاک‌سازی یافت نشد.',
          details: { recovered },
        };
      }

      case 'create_coupon': {
        const rawCode = typeof args.code === 'string' ? args.code.trim().toUpperCase() : '';
        const code = rawCode.replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
        const discountType =
          args.discountType === 'percentage' || args.discountType === 'fixed_stars'
            ? args.discountType
            : 'credits';
        const discountValue = Number(args.discountValue ?? args.creditAmount ?? 0);
        const maxRedemptions =
          typeof args.maxRedemptions === 'number' && args.maxRedemptions > 0
            ? Math.round(args.maxRedemptions)
            : 100;
        const expiresInDays =
          typeof args.expiresInDays === 'number' && args.expiresInDays > 0
            ? Math.round(args.expiresInDays)
            : 30;

        if (!code || code.length < 3 || !Number.isFinite(discountValue) || discountValue <= 0) {
          return {
            actionId,
            tool,
            ok: false,
            summaryFa: 'کد کوپن (حداقل ۳ کاراکتر انگلیسی) یا مقدار آن نامعتبر است.',
          };
        }

        const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
        const [created] = await db
          .insert(coupons)
          .values({
            code,
            discountType,
            discountValue: String(discountValue),
            maxRedemptions,
            perUserLimit: 1,
            isActive: true,
            expiresAt,
          })
          .returning({ id: coupons.id, code: coupons.code });

        await recordAuditLog({
          adminUserId: actor.id,
          actorEmail: actor.email,
          action: 'ai_copilot.create_coupon',
          resourceType: 'coupon',
          resourceId: created!.id,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          details: { code, discountType, discountValue, maxRedemptions, expiresInDays },
        });

        return {
          actionId,
          tool,
          ok: true,
          summaryFa: `کد هدیه/تخفیف «${created!.code}» با مقدار ${discountValue} (${discountType}) و سقف ${maxRedemptions} نفر ساخته شد.`,
          details: { couponId: created!.id, code: created!.code },
        };
      }

      case 'update_bot_messages': {
        const welcomeMessage =
          typeof args.welcomeMessage === 'string' ? args.welcomeMessage.trim() : '';
        const supportUsername =
          typeof args.supportUsername === 'string' ? args.supportUsername.trim() : '';

        if (!welcomeMessage && !supportUsername) {
          return { actionId, tool, ok: false, summaryFa: 'متن پیام خوش‌آمد یا آیدی پشتیبانی مشخص نشده است.' };
        }

        const [existing] = await db
          .select()
          .from(telegramBotSettings)
          .where(eq(telegramBotSettings.singletonKey, 'primary'))
          .limit(1);

        const patch: Partial<typeof telegramBotSettings.$inferInsert> = { updatedAt: new Date() };
        if (welcomeMessage) patch.welcomeMessage = welcomeMessage.slice(0, 2000);
        if (supportUsername) patch.supportUsername = supportUsername.replace(/^@/, '').slice(0, 100);

        if (existing) {
          await db
            .update(telegramBotSettings)
            .set(patch)
            .where(eq(telegramBotSettings.id, existing.id));
        } else {
          await db.insert(telegramBotSettings).values({
            singletonKey: 'primary',
            ...patch,
          });
        }

        await recordAuditLog({
          adminUserId: actor.id,
          actorEmail: actor.email,
          action: 'ai_copilot.update_bot_messages',
          resourceType: 'telegram_bot',
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          details: { updatedWelcome: Boolean(welcomeMessage), updatedSupport: Boolean(supportUsername) },
        });

        return {
          actionId,
          tool,
          ok: true,
          summaryFa: 'تنظیمات پیام ربات تلگرام با موفقیت ذخیره شد.',
        };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'خطای ناشناخته';
    return {
      actionId,
      tool,
      ok: false,
      summaryFa: `خطا در اجرای عملیات: ${msg.slice(0, 180)}`,
    };
  }
}

// =============================================================================
// JSON EXTRACTION & MOCK COPILOT PLANNER
// =============================================================================

export function extractJsonObjectFromText(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fencedMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fallback: locate outermost braces
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const sliced = candidate.slice(start, end + 1);
        const parsed = JSON.parse(sliced);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sanitizeProposedActions(raw: unknown): CopilotProposedAction[] {
  if (!Array.isArray(raw)) return [];
  const out: CopilotProposedAction[] = [];
  for (let i = 0; i < Math.min(raw.length, 6); i++) {
    const item = raw[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') continue;
    const tool = String(item.tool ?? '') as CopilotWriteToolName;
    if (!VALID_WRITE_TOOLS.has(tool)) continue;
    const risk =
      item.risk === 'high' || item.risk === 'medium' || item.risk === 'low'
        ? item.risk
        : 'medium';
    out.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `act-${i + 1}-${crypto.randomUUID().slice(0, 6)}`,
      tool,
      titleFa:
        typeof item.titleFa === 'string' && item.titleFa.trim()
          ? item.titleFa.trim().slice(0, 120)
          : `اجرای ابزار ${tool}`,
      descriptionFa:
        typeof item.descriptionFa === 'string' && item.descriptionFa.trim()
          ? item.descriptionFa.trim().slice(0, 300)
          : 'تغییر مدیریتی پیشنهادی روی سامانه.',
      risk,
      args:
        item.args && typeof item.args === 'object' && !Array.isArray(item.args)
          ? (item.args as Record<string, unknown>)
          : {},
    });
  }
  return out;
}

async function runMockCopilotTurn(
  userPrompt: string,
  toolTraces: CopilotToolTrace[],
): Promise<{ replyFa: string; proposedActions: CopilotProposedAction[] }> {
  const lower = userPrompt.toLowerCase();

  // Always run real read tools against the live DB even in mock mode!
  const t0 = Date.now();
  const overviewRes = await runReadTool('get_platform_overview', {});
  toolTraces.push({
    tool: 'get_platform_overview',
    labelFa: READ_TOOL_LABELS_FA.get_platform_overview,
    args: {},
    summaryFa: overviewRes.summaryFa,
    durationMs: Date.now() - t0,
  });

  if (/رایگان|اولیه|اعتبار.*پلن|پلن.*رایگان|free|credit.*plan|۱۰|10/.test(lower)) {
    const t1 = Date.now();
    const plansRes = await runReadTool('list_plans_and_packages', {});
    toolTraces.push({
      tool: 'list_plans_and_packages',
      labelFa: READ_TOOL_LABELS_FA.list_plans_and_packages,
      args: {},
      summaryFa: plansRes.summaryFa,
      durationMs: Date.now() - t1,
    });
    const plans = (plansRes.data as { plans: Array<{ id: string; name: string; tier: string; creditAllocation: number }> }).plans;
    const freePlan = plans.find((p) => p.tier === 'free') ?? plans[0];
    const numMatch = /(\d+)/.exec(userPrompt.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))));
    const targetCredits = numMatch ? Number(numMatch[1]) : 10;

    return {
      replyFa: freePlan
        ? `پلن «${freePlan.name}» در حال حاضر **${freePlan.creditAllocation} اعتبار** اولیه دارد. کارت تغییر اعتبار به **${targetCredits} اعتبار** آماده است؛ با کلیک روی «تایید و اجرا» بلافاصله اعمال می‌شود.`
        : 'فهرست پلن‌ها بررسی شد اما پلن رایگانی یافت نشد.',
      proposedActions: freePlan
        ? [
            {
              id: `act-plan-${crypto.randomUUID().slice(0, 6)}`,
              tool: 'update_plan',
              titleFa: `تغییر اعتبار پلن «${freePlan.name}» به ${targetCredits}`,
              descriptionFa: `مقدار اعتبار اولیه پلن رایگان از ${freePlan.creditAllocation} به ${targetCredits} اعتبار کاهش/تنظیم می‌شود.`,
              risk: 'low',
              args: { planId: freePlan.id, creditAllocation: targetCredits },
            },
          ]
        : [],
    };
  }

  if (/خراب|پاک|پالایش|مدل|prune|broken|حذف/.test(lower)) {
    const t1 = Date.now();
    const modelsRes = await runReadTool('list_models', { isActive: true });
    toolTraces.push({
      tool: 'list_models',
      labelFa: READ_TOOL_LABELS_FA.list_models,
      args: { isActive: true },
      summaryFa: modelsRes.summaryFa,
      durationMs: Date.now() - t1,
    });

    return {
      replyFa:
        'فهرست مدل‌های فعال بررسی شد. می‌توانم هم‌اکنون تست سلامت را اجرا کنم و **فقط مدل‌های واقعاً خراب** را غیرفعال کنم (مدل‌های سالم و مدل‌هایی که فقط Rate Limit موقت خورده‌اند کاملاً حفظ می‌شوند).',
      proposedActions: [
        {
          id: `act-prune-${crypto.randomUUID().slice(0, 6)}`,
          tool: 'prune_broken_models',
          titleFa: 'پالایش و غیرفعال‌سازی مدل‌های خراب (حفظ لیمیت‌دارها)',
          descriptionFa:
            'مدل‌های فعال را تست کرده و فقط موارد واقعاً خراب (404 / limit:0 / 403) را غیرفعال می‌کند.',
          risk: 'medium',
          args: { mode: 'deactivate_broken' },
        },
      ],
    };
  }

  if (/کوپن|کد تخفیف|هدیه|coupon/.test(lower)) {
    return {
      replyFa:
        'کارت ساخت کد هدیه جدید با اعتبار ۵۰ واحدی برای حداکثر ۱۰۰ کاربر آماده شد. با تایید شما بلافاصله در سامانه فعال می‌شود.',
      proposedActions: [
        {
          id: `act-coupon-${crypto.randomUUID().slice(0, 6)}`,
          tool: 'create_coupon',
          titleFa: 'ساخت کد هدیه WELCOME50',
          descriptionFa: 'ایجاد کوپن ۵۰ اعتباری با سقف ۱۰۰ نفر و اعتبار ۳۰ روزه.',
          risk: 'low',
          args: {
            code: 'WELCOME50',
            discountType: 'credits',
            discountValue: 50,
            maxRedemptions: 100,
            expiresInDays: 30,
          },
        },
      ],
    };
  }

  if (/گیر|متوقف|running|صف|stuck|job/.test(lower)) {
    const t1 = Date.now();
    const jobsRes = await runReadTool('list_generation_jobs', { onlyActive: true });
    toolTraces.push({
      tool: 'list_generation_jobs',
      labelFa: READ_TOOL_LABELS_FA.list_generation_jobs,
      args: { onlyActive: true },
      summaryFa: jobsRes.summaryFa,
      durationMs: Date.now() - t1,
    });

    return {
      replyFa:
        'وضعیت صف پردازش بررسی شد. می‌توانید با اجرای کارت زیر، تمام تسک‌های متوقف‌شده را پاک‌سازی و اعتبار رزرو کاربران را به کیف پولشان بازگردانید.',
      proposedActions: [
        {
          id: `act-jobs-${crypto.randomUUID().slice(0, 6)}`,
          tool: 'recover_stuck_jobs',
          titleFa: 'پاک‌سازی تسک‌های گیرکرده و بازگشت اعتبار',
          descriptionFa: 'تسک‌های متوقف‌شده بیش از ۶۰ ثانیه را متوقف و اعتبار رزروشده را عودت می‌دهد.',
          risk: 'low',
          args: { maxAgeSeconds: 60 },
        },
      ],
    };
  }

  const t1 = Date.now();
  const failRes = await runReadTool('inspect_failed_requests', { limit: 10 });
  toolTraces.push({
    tool: 'inspect_failed_requests',
    labelFa: READ_TOOL_LABELS_FA.inspect_failed_requests,
    args: { limit: 10 },
    summaryFa: failRes.summaryFa,
    durationMs: Date.now() - t1,
  });

  const ov = overviewRes.data as {
    totalUsers: number;
    models: { active: number; total: number };
    providers: { active: number };
    requests24h: { total: number; failed: number };
    activeOrQueuedJobs: number;
  };

  return {
    replyFa: [
      `گزارش وضعیت زنده سامانه هوش‌نگار:`,
      `• تعداد کاربران ثبت‌شده: **${ov.totalUsers}** نفر`,
      `• ارائه‌دهندگان فعال: **${ov.providers.active}** | مدل‌های فعال: **${ov.models.active}** از ${ov.models.total}`,
      `• درخواست‌های ۲۴ ساعت اخیر: **${ov.requests24h.total}** (ناموفق: **${ov.requests24h.failed}**)`,
      `• تسک‌های در حال اجرا/صف: **${ov.activeOrQueuedJobs}**`,
      '',
      'می‌توانید از من بخواهید پلن‌ها را ویرایش کنم، مدل‌های خراب را پالایش کنم، کد هدیه بسازم، خطاها را ریشه‌یابی کنم یا تسک‌های متوقف‌شده را آزاد کنم.',
    ].join('\n'),
    proposedActions:
      ov.activeOrQueuedJobs > 0
        ? [
            {
              id: `act-recover-${crypto.randomUUID().slice(0, 6)}`,
              tool: 'recover_stuck_jobs',
              titleFa: 'بررسی و آزادسازی تسک‌های متوقف‌شده',
              descriptionFa: 'تسک‌های گیرکرده در حالت running را پاک‌سازی و اعتبار را بازگشت می‌دهد.',
              risk: 'low',
              args: { maxAgeSeconds: 60 },
            },
          ]
        : [],
  };
}

// =============================================================================
// MAIN COPILOT ORCHESTRATOR (MULTI-ROUND REACT AGENT)
// =============================================================================

const COPILOT_SYSTEM_PROMPT = `شما «دستیار هوشمند ارشد مدیریت سامانه هوش‌نگار» هستید. شما مدیر فنی، تحلیلگر داده و اپراتور هوشمند یک پلتفرم SaaS هوش مصنوعی و ربات تلگرام هستید.
قوانین پاسخ‌دهی (بسیار مهم):
1. همیشه و فقط یک آبجکت JSON معتبر برگردانید (بدون متن اضافه بیرون از JSON).
2. برای خواندن اطلاعات دقیق از دیتابیس (مانند شناسه واقعی مدل‌ها، پلن‌ها، کاربران، خطاهای اخیر)، ابتدا ابزارهای خواندنی (tool_call) را صدا بزنید. هرگز UUID جعلی نسازید!
3. فقط دو قالب JSON مجاز دارید:
   قالب اول (فراخوانی ابزار خواندنی):
   {"type":"tool_call","tool":"<READ_TOOL>","args":{...},"thoughtFa":"توضیح کوتاه فارسی"}

   قالب دوم (پاسخ نهایی فارسی + کارت‌های اقدام پیشنهادی):
   {"type":"final","replyFa":"پاسخ حرفه‌ای، شفاف و فارسی","proposedActions":[{"id":"act-1","tool":"<WRITE_TOOL>","titleFa":"عنوان کوتاه کارت","descriptionFa":"توضیح دقیق تغییر","risk":"low|medium|high","args":{...}}]}

ابزارهای خواندنی (READ_TOOL):
- get_platform_overview: {} -> آمار کلی کاربران، مدل‌ها، خطاها و تسک‌ها
- list_providers: {} -> فهرست ارائه‌دهندگان، وضعیت اتصال، تعداد کلیدها و مدل‌ها
- list_models: {"providerId?": "uuid", "category?": "llm|multimodal|image|audio|video|embedding|document", "isActive?": true, "search?": "text"}
- inspect_failed_requests: {"limit?": 15} -> لیست خطاهای اخیر و مدل‌های پرخطا
- list_plans_and_packages: {} -> همه پلن‌های اشتراک (مثل پلن رایگان و اعتبار اولیه) و بسته‌های اعتبار
- search_users: {"query?": "username or name or id"} -> جستجوی کاربر و موجودی کیف پول
- list_generation_jobs: {"onlyActive?": true} -> تسک‌های در حال اجرا/متوقف‌شده

ابزارهای اجرایی (WRITE_TOOL — در proposedActions قرار می‌گیرند):
- update_plan: {"planId": "uuid", "creditAllocation?": 10, "starsPrice?": 100, "dailyRequestLimit?": 30, "dailyImageLimit?": 5, "isEnabled?": true, "name?": "..."}
- update_model: {"modelId": "uuid", "isActive?": false, "creditCost?": 2, "priority?": 10, "isDefault?": true, "name?": "..."}
- bulk_update_models: {"providerId?": "uuid", "category?": "image", "search?": "...", "isActive?": false, "creditCost?": 2}
- prune_broken_models: {"providerId?": "uuid", "category?": "llm", "mode": "deactivate_broken"|"delete_broken"} (مدل‌های لیمیت‌دار را حفظ می‌کند و فقط خراب‌ها را پالایش می‌کند)
- adjust_user_credits: {"userId": "uuid", "amount": 50, "reason": "..."}
- recover_stuck_jobs: {"maxAgeSeconds?": 60}
- create_coupon: {"code": "SPRING50", "discountType": "credits"|"percentage"|"fixed_stars", "discountValue": 50, "maxRedemptions": 100, "expiresInDays": 30}
- update_bot_messages: {"welcomeMessage?": "...", "supportUsername?": "..."}

نکته مهم: اگر کاربر صرفاً گزارش یا تحلیل خواست، proposedActions را آرایه خالی [] بگذارید یا فقط در صورت وجود مشکل واقعی، اقدام اصلاحی پیشنهاد دهید.`;

export async function runAdminCopilotChat(params: {
  actor: CopilotAdminActor;
  messages: CopilotChatMessage[];
  modelId?: string;
  autoExecute?: boolean;
}): Promise<CopilotChatResponse> {
  const { actor, messages, autoExecute } = params;
  const lastUserMsg =
    [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() ?? '';

  const toolTraces: CopilotToolTrace[] = [];
  let replyFa = '';
  let proposedActions: CopilotProposedAction[] = [];
  let usedModelId: string | null = null;
  let usedModelName = 'هوش‌نگار Copilot';

  // Choose configured chat model
  const ctx = await getAdminCopilotContext();
  const targetModelId =
    (params.modelId && ctx.availableModels.some((m) => m.id === params.modelId)
      ? params.modelId
      : ctx.recommendedModelId) ?? null;

  if (isAiMockModeEnabled() || !targetModelId) {
    if (!isAiMockModeEnabled() && !targetModelId) {
      return {
        replyFa:
          'در حال حاضر هیچ مدل متنی فعالی در سامانه ثبت نشده است. ابتدا در بخش «ارائه‌دهندگان» یا «مدل‌ها» حداقل یک مدل چت فعال اضافه کنید تا دستیار هوشمند مدیریت با آن اجرا شود.',
        usedModelId: null,
        usedModelName: 'بدون مدل فعال',
        toolTraces: [],
        proposedActions: [],
        executedActions: [],
      };
    }

    const mock = await runMockCopilotTurn(lastUserMsg, toolTraces);
    replyFa = mock.replyFa;
    proposedActions = mock.proposedActions;
    usedModelId = targetModelId;
    usedModelName =
      ctx.availableModels.find((m) => m.id === targetModelId)?.name ?? 'مدل داخلی هوشمند';
  } else {
    const route = await loadModelExecutionRoute(targetModelId);
    usedModelId = route.primary.modelId;
    usedModelName = `${route.primary.modelName} (${route.primary.providerName})`;

    const workingMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...messages.slice(-10).map((m) => ({
        role: m.role,
        content: m.content.slice(0, 4000),
      })),
    ];

    const liveHeader = `وضعیت لحظه‌ای سامانه: کاربران=${ctx.alerts.totalUsers} | ارائه‌دهندگان فعال=${ctx.alerts.activeProviders} | مدل‌های فعال=${ctx.alerts.activeModels} | خطاهای ۲۴ساعت=${ctx.alerts.failedRequests24h} | تسک‌های متوقف=${ctx.alerts.stuckJobs} | اعتبار پلن رایگان=${ctx.alerts.freePlanCredits ?? 'نامشخص'}`;

    for (let round = 0; round < 4; round++) {
      const { result } = await generateTextWithRoute(route, {
        systemPrompt: `${COPILOT_SYSTEM_PROMPT}\n\n${liveHeader}`,
        messages: workingMessages,
        maxTokens: 1200,
        temperature: 0.2,
      });

      const parsed = extractJsonObjectFromText(result.text);
      if (!parsed) {
        // Model answered in plain Persian text — return gracefully
        replyFa = result.text.trim();
        proposedActions = [];
        break;
      }

      if (parsed.type === 'tool_call' && round < 3) {
        const toolName = String(parsed.tool ?? '') as CopilotReadToolName;
        if (!VALID_READ_TOOLS.has(toolName)) {
          workingMessages.push({ role: 'assistant', content: result.text });
          workingMessages.push({
            role: 'user',
            content: `ابزار "${toolName}" معتبر نیست. فقط از ابزارهای خواندنی مجاز استفاده کن یا پاسخ final را بده.`,
          });
          continue;
        }

        const toolArgs =
          parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
            ? (parsed.args as Record<string, unknown>)
            : {};

        const startedAt = Date.now();
        const toolRes = await runReadTool(toolName, toolArgs);
        toolTraces.push({
          tool: toolName,
          labelFa: READ_TOOL_LABELS_FA[toolName],
          args: toolArgs,
          summaryFa: toolRes.summaryFa,
          durationMs: Date.now() - startedAt,
        });

        workingMessages.push({ role: 'assistant', content: result.text });
        workingMessages.push({
          role: 'user',
          content: `نتیجه ابزار ${toolName}:\n${JSON.stringify(toolRes.data).slice(0, 8000)}\n\nحالا در صورت نیاز ابزار بعدی را صدا بزن یا پاسخ final را به فرمت JSON برگردان.`,
        });
        continue;
      }

      replyFa =
        typeof parsed.replyFa === 'string' && parsed.replyFa.trim()
          ? parsed.replyFa.trim()
          : typeof parsed.reply === 'string' && parsed.reply.trim()
            ? parsed.reply.trim()
            : result.text.trim();
      proposedActions = sanitizeProposedActions(parsed.proposedActions);
      break;
    }

    if (!replyFa) {
      replyFa = 'تحلیل انجام شد اما خروجی متنی مشخصی تولید نشد. لطفاً درخواست را دقیق‌تر بیان کنید.';
    }
  }

  // Optional Auto-Execute for power users (only low/medium risk actions auto-run; high risk ALWAYS waits for confirmation!)
  const executedActions: CopilotActionExecutionResult[] = [];
  if (autoExecute && proposedActions.length > 0 && (actor.role === 'admin' || actor.role === 'super_admin')) {
    const remaining: CopilotProposedAction[] = [];
    for (const act of proposedActions) {
      if (act.risk === 'high') {
        remaining.push(act);
        continue;
      }
      const res = await executeAdminCopilotAction({
        actor,
        actionId: act.id,
        tool: act.tool,
        args: act.args,
      });
      executedActions.push(res);
    }
    proposedActions = remaining;
  }

  return {
    replyFa,
    usedModelId,
    usedModelName,
    toolTraces,
    proposedActions,
    executedActions,
  };
}
