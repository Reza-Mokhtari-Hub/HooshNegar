import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiProviders,
  aiRequests,
  creditTransactions,
  creditWallets,
  generationJobs,
  modelCapabilities,
  subscriptionPlans,
  systemSettings,
  usageRecords,
  userLimitOverrides,
  users,
  userSubscriptions,
} from '../../db/schema.ts';
import type { CapabilityType } from '../../shared/validation.ts';
import { redactSecrets } from '../security/crypto.ts';
import { checkAndNotifyLowCredits } from './walletService.ts';

export class UsageGuardError extends Error {
  readonly code:
    | 'USER_NOT_FOUND'
    | 'USER_SUSPENDED'
    | 'MAINTENANCE_MODE'
    | 'NO_ACTIVE_PLAN'
    | 'MODEL_NOT_ALLOWED'
    | 'MODEL_DISABLED'
    | 'CAPABILITY_UNSUPPORTED'
    | 'DAILY_LIMIT_EXCEEDED'
    | 'MONTHLY_LIMIT_EXCEEDED'
    | 'CATEGORY_LIMIT_EXCEEDED'
    | 'CONCURRENT_LIMIT_EXCEEDED'
    | 'INSUFFICIENT_CREDITS'
    | 'DUPLICATE_REQUEST';
  readonly userMessageFa: string;

  constructor(code: UsageGuardError['code'], userMessageFa: string) {
    super(userMessageFa);
    this.name = 'UsageGuardError';
    this.code = code;
    this.userMessageFa = userMessageFa;
  }
}

export interface ReserveUsageInput {
  userId: string;
  modelId: string;
  capability: CapabilityType;
  idempotencyKey: string;
  conversationId?: string | null;
  telegramChatId?: number | null;
  promptPreview?: string;
  jobPayload?: Record<string, unknown>;
}

export interface ReservedUsageHandle {
  requestId: string;
  jobId: string;
  providerId: string;
  modelId: string;
  reservedCredits: number;
  maxFileSizeMb: number;
  maxContextLength: number;
  priorityQueue: boolean;
  alreadyExists: boolean;
}

function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function getMonthPrefix(): string {
  return new Date().toISOString().slice(0, 7);
}

export async function getUserActivePlan(userId: string) {
  const db = getDb();
  const now = new Date();
  const [sub] = await db
    .select({
      subscription: userSubscriptions,
      plan: subscriptionPlans,
    })
    .from(userSubscriptions)
    .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(
      and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.status, 'active'),
        gte(userSubscriptions.endsAt, now),
      ),
    )
    .orderBy(desc(userSubscriptions.endsAt))
    .limit(1);

  if (sub) return sub;

  // Fallback to default free plan if configured
  const [freePlan] = await db
    .select()
    .from(subscriptionPlans)
    .where(and(eq(subscriptionPlans.tier, 'free'), eq(subscriptionPlans.isEnabled, true)))
    .orderBy(subscriptionPlans.sortOrder)
    .limit(1);

  if (!freePlan) return null;

  const endsAt = new Date(Date.now() + freePlan.durationDays * 24 * 60 * 60 * 1000);
  const [createdSub] = await db
    .insert(userSubscriptions)
    .values({
      userId,
      planId: freePlan.id,
      status: 'active',
      startsAt: now,
      endsAt,
      autoRenew: false,
    })
    .returning();

  if (!createdSub) return null;
  return { subscription: createdSub, plan: freePlan };
}

/**
 * Atomically checks account status, subscription entitlements, provider & model allowlists,
 * per-user limit overrides, daily/monthly/category limits, concurrent jobs, and credit balance,
 * then reserves credits and creates an idempotent ai_requests + generation_jobs record.
 */
export async function reserveCreditsAndCreateRequest(
  input: ReserveUsageInput,
): Promise<ReservedUsageHandle> {
  const db = getDb();

  // Check maintenance mode & negative balance policy
  const sysRows = await db
    .select({ key: systemSettings.settingKey, value: systemSettings.value })
    .from(systemSettings);
  const sysMap = new Map(sysRows.map((r) => [r.key, r.value]));
  if (sysMap.get('maintenanceMode') === true) {
    throw new UsageGuardError(
      'MAINTENANCE_MODE',
      'سامانه در حال به‌روزرسانی است. لطفاً کمی بعد مجدداً تلاش کنید.',
    );
  }
  const allowNegativeBalance = sysMap.get('allowNegativeBalance') === true;

  return db.transaction(async (tx) => {
    // 1. Idempotency check (prevent replay / double-charging)
    const [existingReq] = await tx
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.idempotencyKey, input.idempotencyKey))
      .limit(1);

    if (existingReq) {
      const [existingJob] = await tx
        .select({ id: generationJobs.id })
        .from(generationJobs)
        .where(eq(generationJobs.requestId, existingReq.id))
        .limit(1);

      return {
        requestId: existingReq.id,
        jobId: existingJob?.id ?? '',
        providerId: existingReq.providerId ?? '',
        modelId: existingReq.modelId ?? input.modelId,
        reservedCredits: Number(existingReq.creditsCharged),
        maxFileSizeMb: 10,
        maxContextLength: 16000,
        priorityQueue: false,
        alreadyExists: true,
      };
    }

    // 2. Verify user & account status
    const [user] = await tx.select().from(users).where(eq(users.id, input.userId)).limit(1);
    if (!user) {
      throw new UsageGuardError('USER_NOT_FOUND', 'حساب کاربری یافت نشد. لطفاً دستور /start را ارسال کنید.');
    }
    if (user.status !== 'active') {
      throw new UsageGuardError(
        'USER_SUSPENDED',
        'حساب کاربری شما موقتاً معلق یا مسدود شده است. برای پیگیری با پشتیبانی تماس بگیرید.',
      );
    }

    // 3. Verify active plan & optional per-user limit overrides
    const now = new Date();
    const [activeSubRow] = await tx
      .select({
        subscription: userSubscriptions,
        plan: subscriptionPlans,
      })
      .from(userSubscriptions)
      .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
      .where(
        and(
          eq(userSubscriptions.userId, input.userId),
          eq(userSubscriptions.status, 'active'),
          gte(userSubscriptions.endsAt, now),
        ),
      )
      .orderBy(desc(userSubscriptions.endsAt))
      .limit(1);

    if (!activeSubRow) {
      throw new UsageGuardError(
        'NO_ACTIVE_PLAN',
        'اشتراک فعالی برای حساب شما یافت نشد. از بخش 💎 اشتراک و تعرفه‌ها پلن خود را فعال کنید.',
      );
    }

    const plan = activeSubRow.plan;
    const [override] = await tx
      .select()
      .from(userLimitOverrides)
      .where(eq(userLimitOverrides.userId, input.userId))
      .limit(1);

    const effDailyRequestLimit = override?.dailyRequestLimit ?? plan.dailyRequestLimit;
    const effMonthlyRequestLimit = override?.monthlyRequestLimit ?? plan.monthlyRequestLimit;
    const effDailyTextLimit = override?.dailyTextLimit ?? plan.dailyTextLimit;
    const effDailyImageLimit = override?.dailyImageLimit ?? plan.dailyImageLimit;
    const effDailyVideoLimit = override?.dailyVideoLimit ?? plan.dailyVideoLimit;
    const effMaxConcurrentTasks = override?.maxConcurrentTasks ?? plan.maxConcurrentTasks;

    // 4. Verify model, provider, capability, and plan permissions
    const [modelRow] = await tx
      .select({
        model: aiModels,
        providerActive: aiProviders.isActive,
      })
      .from(aiModels)
      .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
      .where(eq(aiModels.id, input.modelId))
      .limit(1);

    if (!modelRow || !modelRow.model.isActive || !modelRow.providerActive) {
      throw new UsageGuardError(
        'MODEL_DISABLED',
        'مدل یا ارائه‌دهنده انتخاب‌شده در حال حاضر غیرفعال است. لطفاً مدل دیگری انتخاب کنید.',
      );
    }

    const acceptableCaps: CapabilityType[] =
      input.capability === 'chat'
        ? ['chat', 'text_generation']
        : input.capability === 'text_generation'
          ? ['text_generation', 'chat']
          : input.capability === 'document_analysis'
            ? ['document_analysis', 'vision', 'chat', 'text_generation']
            : [input.capability];

    const [capRow] = await tx
      .select({ id: modelCapabilities.id })
      .from(modelCapabilities)
      .where(
        and(
          eq(modelCapabilities.modelId, input.modelId),
          inArray(modelCapabilities.capability, acceptableCaps),
        ),
      )
      .limit(1);

    if (!capRow) {
      throw new UsageGuardError(
        'CAPABILITY_UNSUPPORTED',
        'مدل انتخاب‌شده از این قابلیت پشتیبانی نمی‌کند.',
      );
    }

    // Plan provider allowlist
    if (
      Array.isArray(plan.allowedProviderIds) &&
      plan.allowedProviderIds.length > 0 &&
      !plan.allowedProviderIds.includes(modelRow.model.providerId)
    ) {
      throw new UsageGuardError(
        'MODEL_NOT_ALLOWED',
        `دسترسی به ارائه‌دهنده این مدل در پلن فعلی شما (${plan.name}) مجاز نیست. از منوی 💎 اشتراک و تعرفه‌ها ارتقا دهید.`,
      );
    }

    // Plan model allowlist
    if (
      Array.isArray(plan.availableModelIds) &&
      plan.availableModelIds.length > 0 &&
      !plan.availableModelIds.includes(input.modelId)
    ) {
      throw new UsageGuardError(
        'MODEL_NOT_ALLOWED',
        `دسترسی به مدل «${modelRow.model.name}» در پلن فعلی شما (${plan.name}) مجاز نیست. برای ارتقا از منوی 💎 اشتراک و تعرفه‌ها اقدام کنید.`,
      );
    }

    // Model allowed plan tiers
    if (
      Array.isArray(modelRow.model.allowedPlanTiers) &&
      modelRow.model.allowedPlanTiers.length > 0 &&
      !modelRow.model.allowedPlanTiers.includes(plan.tier)
    ) {
      throw new UsageGuardError(
        'MODEL_NOT_ALLOWED',
        `مدل «${modelRow.model.name}» مخصوص پلن‌های بالاتر است. برای دسترسی، اشتراک خود را از /buy ارتقا دهید.`,
      );
    }

    // 5. Daily & Monthly overall limits
    const todayStr = getTodayDateString();
    const monthPrefix = getMonthPrefix();

    const [dailyRow] = await tx
      .select({ total: count() })
      .from(usageRecords)
      .where(and(eq(usageRecords.userId, input.userId), eq(usageRecords.recordedDate, todayStr)));

    if ((dailyRow?.total ?? 0) >= effDailyRequestLimit) {
      throw new UsageGuardError(
        'DAILY_LIMIT_EXCEEDED',
        `به سقف مجاز درخواست روزانه پلن خود (${effDailyRequestLimit} درخواست) رسیده‌اید.`,
      );
    }

    const [monthlyRow] = await tx
      .select({ total: count() })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.userId, input.userId),
          sql`${usageRecords.recordedDate} like ${`${monthPrefix}%`}`,
        ),
      );

    if ((monthlyRow?.total ?? 0) >= effMonthlyRequestLimit) {
      throw new UsageGuardError(
        'MONTHLY_LIMIT_EXCEEDED',
        `به سقف مجاز درخواست ماهانه پلن خود (${effMonthlyRequestLimit} درخواست) رسیده‌اید.`,
      );
    }

    // Category-specific daily & monthly quotas
    const categoryCaps: Partial<
      Record<CapabilityType, { dailyLimit?: number; monthlyLimit: number; caps: CapabilityType[]; label: string }>
    > = {
      text_generation: {
        dailyLimit: effDailyTextLimit,
        monthlyLimit: plan.textGenerationLimit,
        caps: ['text_generation', 'chat'],
        label: 'درخواست متنی',
      },
      chat: {
        dailyLimit: effDailyTextLimit,
        monthlyLimit: plan.textGenerationLimit,
        caps: ['text_generation', 'chat'],
        label: 'درخواست متنی',
      },
      image_generation: {
        dailyLimit: effDailyImageLimit,
        monthlyLimit: plan.imageGenerationLimit,
        caps: ['image_generation', 'image_editing', 'image_variation'],
        label: 'ساخت/ویرایش تصویر',
      },
      image_editing: {
        dailyLimit: effDailyImageLimit,
        monthlyLimit: plan.imageGenerationLimit,
        caps: ['image_generation', 'image_editing', 'image_variation'],
        label: 'ساخت/ویرایش تصویر',
      },
      image_variation: {
        dailyLimit: effDailyImageLimit,
        monthlyLimit: plan.imageGenerationLimit,
        caps: ['image_generation', 'image_editing', 'image_variation'],
        label: 'ساخت/ویرایش تصویر',
      },
      video_generation: {
        dailyLimit: effDailyVideoLimit,
        monthlyLimit: plan.videoGenerationLimit,
        caps: ['video_generation'],
        label: 'ساخت ویدیو',
      },
      audio_transcription: {
        monthlyLimit: plan.audioGenerationLimit,
        caps: ['audio_transcription', 'speech_generation'],
        label: 'پردازش صوت',
      },
      speech_generation: {
        monthlyLimit: plan.audioGenerationLimit,
        caps: ['audio_transcription', 'speech_generation'],
        label: 'پردازش صوت',
      },
    };
    const catCheck = categoryCaps[input.capability];
    if (catCheck) {
      if (catCheck.monthlyLimit <= 0) {
        throw new UsageGuardError(
          'CATEGORY_LIMIT_EXCEEDED',
          `قابلیت ${catCheck.label} در پلن فعلی شما (${plan.name}) فعال نیست.`,
        );
      }
      if (catCheck.dailyLimit !== undefined) {
        if (catCheck.dailyLimit <= 0) {
          throw new UsageGuardError(
            'CATEGORY_LIMIT_EXCEEDED',
            `سقف روزانه ${catCheck.label} در پلن شما فعال نیست.`,
          );
        }
        const [dailyCatRow] = await tx
          .select({ total: count() })
          .from(usageRecords)
          .where(
            and(
              eq(usageRecords.userId, input.userId),
              inArray(usageRecords.capability, catCheck.caps),
              eq(usageRecords.recordedDate, todayStr),
            ),
          );
        if ((dailyCatRow?.total ?? 0) >= catCheck.dailyLimit) {
          throw new UsageGuardError(
            'CATEGORY_LIMIT_EXCEEDED',
            `سهمیه روزانه ${catCheck.label} شما (${catCheck.dailyLimit} مورد) به پایان رسیده است.`,
          );
        }
      }
      const [catCountRow] = await tx
        .select({ total: count() })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, input.userId),
            inArray(usageRecords.capability, catCheck.caps),
            sql`${usageRecords.recordedDate} like ${`${monthPrefix}%`}`,
          ),
        );
      if ((catCountRow?.total ?? 0) >= catCheck.monthlyLimit) {
        throw new UsageGuardError(
          'CATEGORY_LIMIT_EXCEEDED',
          `سهمیه ماهانه ${catCheck.label} شما (${catCheck.monthlyLimit} مورد) به پایان رسیده است.`,
        );
      }
    }

    // 6. Concurrent job limit
    const [activeJobsRow] = await tx
      .select({ total: count() })
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.userId, input.userId),
          inArray(generationJobs.status, ['queued', 'running']),
        ),
      );

    if ((activeJobsRow?.total ?? 0) >= effMaxConcurrentTasks) {
      throw new UsageGuardError(
        'CONCURRENT_LIMIT_EXCEEDED',
        `حداکثر ${effMaxConcurrentTasks} پردازش همزمان مجاز است. لطفاً تا پایان پردازش فعلی صبر کنید یا از /cancel استفاده کنید.`,
      );
    }

    // 7. Lock wallet row and atomically reserve credits (honoring minCreditCost floor)
    const creditCost = Math.max(
      0,
      Number(modelRow.model.creditCost),
      Number(modelRow.model.minCreditCost ?? 0),
    );
    let [wallet] = await tx
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, input.userId))
      .for('update');

    if (!wallet) {
      const [createdWallet] = await tx
        .insert(creditWallets)
        .values({
          userId: input.userId,
          balance: String(plan.creditAllocation),
          reservedBalance: '0',
          lifetimeEarned: String(plan.creditAllocation),
          lifetimeSpent: '0',
        })
        .returning();
      wallet = createdWallet;
    }

    if (!wallet) {
      throw new UsageGuardError('INSUFFICIENT_CREDITS', 'خطا در دسترسی به کیف‌پول اعتبار.');
    }

    const available = Number(wallet.balance) - Number(wallet.reservedBalance);
    if (!allowNegativeBalance && available < creditCost) {
      throw new UsageGuardError(
        'INSUFFICIENT_CREDITS',
        `اعتبار شما کافی نیست. هزینه این عملیات ${creditCost} اعتبار و موجودی قابل استفاده شما ${Math.max(0, available).toFixed(2)} اعتبار است.`,
      );
    }

    const nextReserved = Number(wallet.reservedBalance) + creditCost;
    await tx
      .update(creditWallets)
      .set({
        reservedBalance: nextReserved.toFixed(4),
        updatedAt: now,
      })
      .where(eq(creditWallets.id, wallet.id));

    // 8. Create idempotent ai_requests & generation_jobs records
    const [reqRow] = await tx
      .insert(aiRequests)
      .values({
        userId: input.userId,
        providerId: modelRow.model.providerId,
        modelId: modelRow.model.id,
        conversationId: input.conversationId ?? null,
        capability: input.capability,
        status: 'queued',
        idempotencyKey: input.idempotencyKey,
        creditsCharged: creditCost.toFixed(4),
        promptPreview: input.promptPreview ? redactSecrets(input.promptPreview).slice(0, 280) : null,
      })
      .returning();

    if (!reqRow) throw new Error('Failed to insert ai_requests row');

    const [jobRow] = await tx
      .insert(generationJobs)
      .values({
        requestId: reqRow.id,
        userId: input.userId,
        telegramChatId: input.telegramChatId ?? null,
        capability: input.capability,
        status: 'queued',
        progressPercent: 5,
        attempts: 0,
        maxAttempts: 3,
        payload: input.jobPayload ?? {},
      })
      .returning();

    if (!jobRow) throw new Error('Failed to insert generation_jobs row');

    return {
      requestId: reqRow.id,
      jobId: jobRow.id,
      providerId: modelRow.model.providerId,
      modelId: modelRow.model.id,
      reservedCredits: creditCost,
      maxFileSizeMb: plan.maxFileSizeMb,
      maxContextLength: plan.maxContextLength,
      priorityQueue: plan.priorityQueue,
      alreadyExists: false,
    };
  });
}

/**
 * Reconciles a completed AI request: finalizes credit debit from balance + reservedBalance,
 * writes idempotent credit_transactions (with balanceBefore & balanceAfter) & usage_records,
 * updates request/job status, and triggers low-credit notifications if balance falls below threshold.
 */
export async function reconcileRequestSuccess(params: {
  requestId: string;
  jobId?: string;
  providerId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  actualCredits?: number;
  responsePreview?: string;
  usedFallback?: boolean;
  storageObjectKey?: string | null;
  resultMetadata?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  const now = new Date();
  const todayStr = getTodayDateString();

  let notifyTarget: { userId: string; balance: number } | null = null;

  await db.transaction(async (tx) => {
    const [reqRow] = await tx
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.id, params.requestId))
      .for('update');

    if (!reqRow || reqRow.status === 'succeeded' || reqRow.status === 'failed' || reqRow.status === 'canceled') {
      return;
    }

    const reserved = Number(reqRow.creditsCharged);
    const finalCharge = params.actualCredits !== undefined ? Math.max(0, params.actualCredits) : reserved;

    // Incorporate configured providerCostPerOpUsd floor when model cost is available
    let effectiveCostUsd = params.costUsd ?? 0;
    if (reqRow.modelId) {
      const [mRow] = await tx
        .select({ providerCostPerOpUsd: aiModels.providerCostPerOpUsd })
        .from(aiModels)
        .where(eq(aiModels.id, reqRow.modelId))
        .limit(1);
      if (mRow && Number(mRow.providerCostPerOpUsd) > effectiveCostUsd) {
        effectiveCostUsd = Number(mRow.providerCostPerOpUsd);
      }
    }

    const [wallet] = await tx
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, reqRow.userId))
      .for('update');

    if (wallet) {
      const balanceBefore = Number(wallet.balance);
      const nextBalance = Number((balanceBefore - finalCharge).toFixed(4));
      const nextReserved = Math.max(0, Number(wallet.reservedBalance) - reserved);
      const nextSpent = Number(wallet.lifetimeSpent) + finalCharge;

      await tx
        .update(creditWallets)
        .set({
          balance: nextBalance.toFixed(4),
          reservedBalance: nextReserved.toFixed(4),
          lifetimeSpent: nextSpent.toFixed(4),
          updatedAt: now,
        })
        .where(eq(creditWallets.id, wallet.id));

      if (finalCharge > 0) {
        await tx
          .insert(creditTransactions)
          .values({
            walletId: wallet.id,
            userId: reqRow.userId,
            type: 'usage_debit',
            amount: (-finalCharge).toFixed(4),
            balanceBefore: balanceBefore.toFixed(4),
            balanceAfter: nextBalance.toFixed(4),
            idempotencyKey: `debit:${reqRow.id}`,
            referenceType: 'ai_request',
            referenceId: reqRow.id,
            relatedRequestId: reqRow.id,
            description: `مصرف اعتبار برای ${reqRow.capability}`,
          })
          .onConflictDoNothing();

        notifyTarget = { userId: reqRow.userId, balance: nextBalance };
      }
    }

    await tx
      .update(aiRequests)
      .set({
        providerId: params.providerId ?? reqRow.providerId,
        status: 'succeeded',
        inputTokens: params.inputTokens ?? 0,
        outputTokens: params.outputTokens ?? 0,
        creditsCharged: finalCharge.toFixed(4),
        costUsd: effectiveCostUsd.toFixed(6),
        latencyMs: params.latencyMs ?? null,
        responsePreview: params.responsePreview
          ? redactSecrets(params.responsePreview).slice(0, 320)
          : null,
        usedFallback: params.usedFallback ?? false,
        completedAt: now,
      })
      .where(eq(aiRequests.id, reqRow.id));

    await tx.insert(usageRecords).values({
      userId: reqRow.userId,
      providerId: params.providerId ?? reqRow.providerId,
      modelId: reqRow.modelId,
      requestId: reqRow.id,
      capability: reqRow.capability,
      unitsConsumed: 1,
      creditsConsumed: finalCharge.toFixed(4),
      costUsd: effectiveCostUsd.toFixed(6),
      recordedDate: todayStr,
    });

    if (params.jobId) {
      await tx
        .update(generationJobs)
        .set({
          status: 'succeeded',
          progressPercent: 100,
          storageObjectKey: params.storageObjectKey ?? null,
          resultMetadata: params.resultMetadata ?? {},
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(generationJobs.id, params.jobId));
    }
  });

  if (notifyTarget) {
    const target = notifyTarget as { userId: string; balance: number };
    await checkAndNotifyLowCredits(target.userId, target.balance);
  }
}

/**
 * Releases reserved credits when a generation fails or is canceled.
 * Guarantees users are NEVER charged for failed generations.
 */
export async function refundFailedRequest(params: {
  requestId: string;
  jobId?: string;
  errorCode: string;
  errorMessage: string;
  canceled?: boolean;
  latencyMs?: number;
}): Promise<void> {
  const db = getDb();
  const now = new Date();
  const targetStatus = params.canceled ? 'canceled' : 'failed';

  await db.transaction(async (tx) => {
    const [reqRow] = await tx
      .select()
      .from(aiRequests)
      .where(eq(aiRequests.id, params.requestId))
      .for('update');

    if (!reqRow || reqRow.status === 'succeeded' || reqRow.status === 'failed' || reqRow.status === 'canceled') {
      return;
    }

    const reserved = Number(reqRow.creditsCharged);
    const [wallet] = await tx
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, reqRow.userId))
      .for('update');

    if (wallet && reserved > 0) {
      const nextReserved = Math.max(0, Number(wallet.reservedBalance) - reserved);
      await tx
        .update(creditWallets)
        .set({
          reservedBalance: nextReserved.toFixed(4),
          updatedAt: now,
        })
        .where(eq(creditWallets.id, wallet.id));
    }

    await tx
      .update(aiRequests)
      .set({
        status: targetStatus,
        creditsCharged: '0',
        latencyMs: params.latencyMs ?? null,
        errorCode: params.errorCode,
        errorMessage: redactSecrets(params.errorMessage).slice(0, 2000),
        completedAt: now,
      })
      .where(eq(aiRequests.id, reqRow.id));

    if (params.jobId) {
      await tx
        .update(generationJobs)
        .set({
          status: targetStatus,
          errorMessage: redactSecrets(params.errorMessage).slice(0, 2000),
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(generationJobs.id, params.jobId));
    }
  });
}
