import crypto from 'node:crypto';
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiProviders,
  conversations,
  creditTransactions,
  creditWallets,
  modelCapabilities,
  payments,
  referralCodes,
  referralRelationships,
  referralRewards,
  subscriptionPlans,
  telegramAccounts,
  telegramBotSettings,
  usageRecords,
  userProfiles,
  users,
  userSubscriptions,
  type TelegramUserBotState,
} from '../../db/schema.ts';
import type { CapabilityType, ModelCategory } from '../../shared/validation.ts';
import { attributeReferralSignup } from '../services/referralCouponService.ts';

export interface TelegramIdentityInput {
  telegramUserId: number;
  telegramChatId: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  isPremium?: boolean;
  referralCode?: string | null;
}

export interface EnsuredTelegramUser {
  isNewUser: boolean;
  referralApplied: boolean;
  user: typeof users.$inferSelect;
  profile: typeof userProfiles.$inferSelect | null;
  telegramAccount: typeof telegramAccounts.$inferSelect;
  plan: typeof subscriptionPlans.$inferSelect | null;
  subscription: typeof userSubscriptions.$inferSelect | null;
  walletBalance: number;
  reservedBalance: number;
}

export interface DynamicAvailableModel {
  id: string;
  name: string;
  modelIdentifier: string;
  category: ModelCategory;
  description: string;
  providerId: string;
  providerName: string;
  providerType: string;
  creditCost: number;
  priority: number;
  isDefault: boolean;
  capabilities: CapabilityType[];
}

function generatePersonalReferralCode(tgUserId: number): string {
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `HN${String(tgUserId).slice(-4)}${rand}`;
}

/**
 * Links a Telegram identity to a unique internal user record.
 * Creates user + profile + telegram_account + default Free plan + credit wallet
 * + personal referral code, then runs configurable Phase 3 referral attribution.
 */
export async function ensureTelegramUser(input: TelegramIdentityInput): Promise<EnsuredTelegramUser> {
  const db = getDb();
  const now = new Date();
  const preferredLang = input.languageCode?.toLowerCase().startsWith('en') ? 'en' : 'fa';

  const baseResult = await db.transaction(async (tx) => {
    const [existingTg] = await tx
      .select()
      .from(telegramAccounts)
      .where(eq(telegramAccounts.telegramUserId, input.telegramUserId))
      .limit(1);

    let userRow: typeof users.$inferSelect;
    let tgRow: typeof telegramAccounts.$inferSelect;
    let profileRow: typeof userProfiles.$inferSelect | null = null;
    let isNewUser = false;

    if (existingTg) {
      const [u] = await tx.select().from(users).where(eq(users.id, existingTg.userId)).limit(1);
      if (!u) throw new Error('Orphan telegram_account without user');
      userRow = u;

      const [updatedTg] = await tx
        .update(telegramAccounts)
        .set({
          telegramChatId: input.telegramChatId,
          username: input.username ?? existingTg.username,
          firstName: input.firstName ?? existingTg.firstName,
          lastName: input.lastName ?? existingTg.lastName,
          languageCode: input.languageCode ?? existingTg.languageCode,
          isPremiumTelegram: input.isPremium ?? existingTg.isPremiumTelegram,
          lastInteractionAt: now,
          updatedAt: now,
        })
        .where(eq(telegramAccounts.id, existingTg.id))
        .returning();

      tgRow = updatedTg ?? existingTg;

      await tx
        .update(users)
        .set({ lastActiveAt: now, updatedAt: now })
        .where(eq(users.id, u.id));

      const [prof] = await tx
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, u.id))
        .limit(1);
      profileRow = prof ?? null;
    } else {
      isNewUser = true;
      const [createdUser] = await tx
        .insert(users)
        .values({
          externalUid: `tg:${input.telegramUserId}`,
          status: 'active',
          locale: preferredLang,
          lastActiveAt: now,
        })
        .returning();
      if (!createdUser) throw new Error('Failed to create user');
      userRow = createdUser;

      const displayName =
        [input.firstName, input.lastName].filter(Boolean).join(' ').trim() ||
        (input.username ? `@${input.username}` : `کاربر ${input.telegramUserId}`);

      const [createdProfile] = await tx
        .insert(userProfiles)
        .values({
          userId: userRow.id,
          displayName,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
        })
        .returning();
      profileRow = createdProfile ?? null;

      const [createdTg] = await tx
        .insert(telegramAccounts)
        .values({
          userId: userRow.id,
          telegramUserId: input.telegramUserId,
          telegramChatId: input.telegramChatId,
          username: input.username ?? null,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          languageCode: preferredLang,
          isPremiumTelegram: Boolean(input.isPremium),
          lastInteractionAt: now,
        })
        .returning();
      if (!createdTg) throw new Error('Failed to create telegram account');
      tgRow = createdTg;

      // Create user's personal referral code
      const personalCode = generatePersonalReferralCode(input.telegramUserId);
      await tx
        .insert(referralCodes)
        .values({
          ownerUserId: userRow.id,
          code: personalCode,
          rewardCredits: 50,
          isActive: true,
        })
        .onConflictDoNothing();
    }

    // Ensure active subscription (assign default Free plan if none)
    let [activeSub] = await tx
      .select({
        sub: userSubscriptions,
        plan: subscriptionPlans,
      })
      .from(userSubscriptions)
      .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
      .where(
        and(
          eq(userSubscriptions.userId, userRow.id),
          eq(userSubscriptions.status, 'active'),
          gte(userSubscriptions.endsAt, now),
        ),
      )
      .orderBy(desc(userSubscriptions.endsAt))
      .limit(1);

    if (!activeSub) {
      const [freePlan] = await tx
        .select()
        .from(subscriptionPlans)
        .where(and(eq(subscriptionPlans.tier, 'free'), eq(subscriptionPlans.isEnabled, true)))
        .orderBy(subscriptionPlans.sortOrder)
        .limit(1);

      if (freePlan) {
        const endsAt = new Date(Date.now() + freePlan.durationDays * 24 * 60 * 60 * 1000);
        const [newSub] = await tx
          .insert(userSubscriptions)
          .values({
            userId: userRow.id,
            planId: freePlan.id,
            status: 'active',
            startsAt: now,
            endsAt,
            autoRenew: false,
          })
          .returning();
        if (newSub) {
          activeSub = { sub: newSub, plan: freePlan };
        }
      }
    }

    // Ensure credit wallet exists
    let [wallet] = await tx
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, userRow.id))
      .limit(1);

    if (!wallet) {
      const initialCredits = activeSub?.plan.creditAllocation ?? 50;
      const [createdWallet] = await tx
        .insert(creditWallets)
        .values({
          userId: userRow.id,
          balance: initialCredits.toFixed(4),
          reservedBalance: '0',
          lifetimeEarned: initialCredits.toFixed(4),
          lifetimeSpent: '0',
        })
        .returning();
      wallet = createdWallet;

      if (wallet && initialCredits > 0) {
        await tx
          .insert(creditTransactions)
          .values({
            walletId: wallet.id,
            userId: userRow.id,
            type: 'grant',
            amount: initialCredits.toFixed(4),
            balanceBefore: '0',
            balanceAfter: initialCredits.toFixed(4),
            idempotencyKey: `welcome_grant:${userRow.id}`,
            referenceType: 'registration',
            referenceId: userRow.id,
            description: 'اعتبار خوش‌آمدگویی پلن پایه',
          })
          .onConflictDoNothing();
      }
    }

    return {
      isNewUser,
      user: userRow,
      profile: profileRow,
      telegramAccount: tgRow,
      plan: activeSub?.plan ?? null,
      subscription: activeSub?.sub ?? null,
      walletBalance: Number(wallet?.balance ?? 0),
      reservedBalance: Number(wallet?.reservedBalance ?? 0),
    };
  });

  let referralApplied = false;
  let walletBalance = baseResult.walletBalance;

  // Apply Phase 3 configurable referral attribution outside transaction
  if (baseResult.isNewUser && input.referralCode) {
    const cleanCode = input.referralCode.trim().toUpperCase().replace(/^REF[_-]?/, '');
    if (cleanCode.length >= 3) {
      const refRes = await attributeReferralSignup({
        referredUserId: baseResult.user.id,
        referralCode: cleanCode,
      });
      referralApplied = refRes.attributed;
      if (refRes.immediateAward) {
        const [freshWallet] = await db
          .select({ balance: creditWallets.balance })
          .from(creditWallets)
          .where(eq(creditWallets.userId, baseResult.user.id))
          .limit(1);
        if (freshWallet) walletBalance = Number(freshWallet.balance);
      }
    }
  }

  return {
    ...baseResult,
    referralApplied,
    walletBalance,
  };
}

export async function getUserActivePlan(userId: string) {
  const db = getDb();
  const now = new Date();
  const [activeSub] = await db
    .select({
      sub: userSubscriptions,
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

  return activeSub ?? null;
}

export type ModelCategoryGroup = 'text' | 'image' | 'video' | 'audio' | 'multimodal' | 'all';

function capabilityMatches(modelCaps: CapabilityType[], target: CapabilityType): boolean {
  if (modelCaps.includes(target)) return true;
  if (target === 'chat') return modelCaps.includes('text_generation');
  if (target === 'text_generation') return modelCaps.includes('chat');
  if (target === 'document_analysis') {
    return modelCaps.includes('vision') || modelCaps.includes('chat');
  }
  return false;
}

function matchesCategoryGroup(
  model: { category: ModelCategory; capabilities: CapabilityType[] },
  group: ModelCategoryGroup,
): boolean {
  if (group === 'all') return true;
  if (group === 'text') {
    if (model.category === 'embedding') return false;
    return (
      model.category === 'llm' ||
      model.category === 'multimodal' ||
      model.capabilities.includes('chat') ||
      model.capabilities.includes('text_generation')
    );
  }
  if (group === 'image') {
    return (
      model.category === 'image' ||
      model.capabilities.includes('image_generation') ||
      model.capabilities.includes('image_editing') ||
      model.capabilities.includes('image_variation')
    );
  }
  if (group === 'video') {
    return model.category === 'video' || model.capabilities.includes('video_generation');
  }
  if (group === 'audio') {
    return (
      model.category === 'audio' ||
      model.capabilities.includes('speech_generation') ||
      model.capabilities.includes('audio_transcription')
    );
  }
  if (group === 'multimodal') {
    return (
      model.category === 'multimodal' ||
      model.category === 'document' ||
      model.capabilities.includes('vision') ||
      model.capabilities.includes('document_analysis')
    );
  }
  return true;
}

/**
 * Dynamically fetches enabled AI models from database for a user,
 * strictly honoring provider active status, model active status,
 * capability/categoryGroup filter, plan allowedProviderIds, availableModelIds, and model allowedPlanTiers.
 */
export async function getAvailableModelsForUser(params: {
  userId: string;
  capability?: CapabilityType;
  category?: ModelCategory;
  categoryGroup?: ModelCategoryGroup;
}): Promise<DynamicAvailableModel[]> {
  const db = getDb();
  const now = new Date();

  const [activeSub] = await db
    .select({
      availableModelIds: subscriptionPlans.availableModelIds,
      allowedProviderIds: subscriptionPlans.allowedProviderIds,
      tier: subscriptionPlans.tier,
    })
    .from(userSubscriptions)
    .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(
      and(
        eq(userSubscriptions.userId, params.userId),
        eq(userSubscriptions.status, 'active'),
        gte(userSubscriptions.endsAt, now),
      ),
    )
    .orderBy(desc(userSubscriptions.endsAt))
    .limit(1);

  const modelAllowlist =
    activeSub?.availableModelIds && activeSub.availableModelIds.length > 0
      ? new Set(activeSub.availableModelIds)
      : null;

  const providerAllowlist =
    activeSub?.allowedProviderIds && activeSub.allowedProviderIds.length > 0
      ? new Set(activeSub.allowedProviderIds)
      : null;

  const userTier = activeSub?.tier ?? 'free';

  const [models, caps] = await Promise.all([
    db
      .select({
        id: aiModels.id,
        name: aiModels.name,
        modelIdentifier: aiModels.modelIdentifier,
        category: aiModels.category,
        description: aiModels.description,
        providerId: aiModels.providerId,
        providerName: aiProviders.name,
        providerType: aiProviders.providerType,
        creditCost: aiModels.creditCost,
        minCreditCost: aiModels.minCreditCost,
        allowedPlanTiers: aiModels.allowedPlanTiers,
        priority: aiModels.priority,
        isDefault: aiModels.isDefault,
      })
      .from(aiModels)
      .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
      .where(and(eq(aiModels.isActive, true), eq(aiProviders.isActive, true)))
      .orderBy(desc(aiModels.isDefault), aiModels.priority, aiModels.name),
    db.select().from(modelCapabilities),
  ]);

  const capsByModel = new Map<string, CapabilityType[]>();
  for (const c of caps) {
    const arr = capsByModel.get(c.modelId) ?? [];
    arr.push(c.capability);
    capsByModel.set(c.modelId, arr);
  }

  return models
    .map((m) => ({
      id: m.id,
      name: m.name,
      modelIdentifier: m.modelIdentifier,
      category: m.category,
      description: m.description,
      providerId: m.providerId,
      providerName: m.providerName,
      providerType: m.providerType,
      creditCost: Math.max(Number(m.creditCost), Number(m.minCreditCost ?? 0)),
      priority: m.priority,
      isDefault: m.isDefault,
      allowedPlanTiers: m.allowedPlanTiers ?? [],
      capabilities: capsByModel.get(m.id) ?? [],
    }))
    .filter((m) => {
      if (providerAllowlist && !providerAllowlist.has(m.providerId)) return false;
      if (modelAllowlist && !modelAllowlist.has(m.id)) return false;
      if (m.allowedPlanTiers.length > 0 && !m.allowedPlanTiers.includes(userTier)) return false;
      if (params.category && m.category !== params.category) return false;
      if (params.categoryGroup && !matchesCategoryGroup(m, params.categoryGroup)) return false;
      if (params.capability && !capabilityMatches(m.capabilities, params.capability)) return false;
      return true;
    })
    .map(({ allowedPlanTiers: _ignored, ...rest }) => rest);
}

export async function resolveSelectedModelForCapability(params: {
  userId: string;
  telegramAccount: typeof telegramAccounts.$inferSelect;
  capability: CapabilityType;
}): Promise<DynamicAvailableModel | null> {
  const available = await getAvailableModelsForUser({
    userId: params.userId,
    capability: params.capability,
  });

  if (available.length === 0) return null;

  const preferredId =
    params.capability === 'image_generation' ||
    params.capability === 'image_editing' ||
    params.capability === 'image_variation'
      ? params.telegramAccount.selectedImageModelId
      : params.capability === 'video_generation'
        ? params.telegramAccount.selectedVideoModelId
        : params.capability === 'audio_transcription' || params.capability === 'speech_generation'
          ? params.telegramAccount.selectedAudioModelId
          : params.capability === 'document_analysis'
            ? params.telegramAccount.selectedDocumentModelId ?? params.telegramAccount.selectedTextModelId
            : params.telegramAccount.selectedTextModelId;

  if (preferredId) {
    const found = available.find((m) => m.id === preferredId);
    if (found) return found;
  }

  const db = getDb();
  const [botCfg] = await db
    .select({ defaultModelId: telegramBotSettings.defaultModelId })
    .from(telegramBotSettings)
    .where(eq(telegramBotSettings.singletonKey, 'primary'))
    .limit(1);

  if (botCfg?.defaultModelId) {
    const defaultMatch = available.find((m) => m.id === botCfg.defaultModelId);
    if (defaultMatch) return defaultMatch;
  }

  return available.find((m) => m.isDefault) ?? available[0] ?? null;
}

export async function updateTelegramUserState(
  telegramAccountId: string,
  patch: Partial<TelegramUserBotState>,
  extraColumns?: Partial<typeof telegramAccounts.$inferInsert>,
): Promise<void> {
  const db = getDb();
  const [current] = await db
    .select({ botState: telegramAccounts.botState })
    .from(telegramAccounts)
    .where(eq(telegramAccounts.id, telegramAccountId))
    .limit(1);

  const nextState: TelegramUserBotState = {
    ...(current?.botState ?? {}),
    ...patch,
  };

  await db
    .update(telegramAccounts)
    .set({
      botState: nextState,
      ...(extraColumns ?? {}),
      updatedAt: new Date(),
    })
    .where(eq(telegramAccounts.id, telegramAccountId));
}

export async function getOrCreateActiveConversation(params: {
  userId: string;
  telegramAccount: typeof telegramAccounts.$inferSelect;
  modelId: string | null;
  forceNew?: boolean;
  title?: string;
}): Promise<typeof conversations.$inferSelect> {
  const db = getDb();
  if (!params.forceNew && params.telegramAccount.activeConversationId) {
    const [existing] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, params.telegramAccount.activeConversationId),
          eq(conversations.userId, params.userId),
          eq(conversations.status, 'active'),
        ),
      )
      .limit(1);
    if (existing) return existing;
  }

  const [created] = await db
    .insert(conversations)
    .values({
      userId: params.userId,
      telegramAccountId: params.telegramAccount.id,
      modelId: params.modelId,
      title: (params.title || 'گفتگوی جدید').slice(0, 120),
      status: 'active',
    })
    .returning();

  if (!created) throw new Error('Failed to create conversation');

  await db
    .update(telegramAccounts)
    .set({ activeConversationId: created.id, updatedAt: new Date() })
    .where(eq(telegramAccounts.id, params.telegramAccount.id));

  return created;
}

export async function getUserUsageSnapshot(userId: string): Promise<{
  todayRequests: number;
  monthRequests: number;
  monthImages: number;
  monthVideos: number;
  monthAudio: number;
  referralCode: string | null;
  referredCount: number;
}> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const monthPrefix = new Date().toISOString().slice(0, 7);

  const [[todayRow], [monthRow], [imgRow], [vidRow], [audRow], [refCode], [refCount]] =
    await Promise.all([
      db
        .select({ total: count() })
        .from(usageRecords)
        .where(and(eq(usageRecords.userId, userId), eq(usageRecords.recordedDate, today))),
      db
        .select({ total: count() })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, userId),
            sql`${usageRecords.recordedDate} like ${`${monthPrefix}%`}`,
          ),
        ),
      db
        .select({ total: count() })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, userId),
            inArray(usageRecords.capability, ['image_generation', 'image_editing', 'image_variation']),
            sql`${usageRecords.recordedDate} like ${`${monthPrefix}%`}`,
          ),
        ),
      db
        .select({ total: count() })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, userId),
            eq(usageRecords.capability, 'video_generation'),
            sql`${usageRecords.recordedDate} like ${`${monthPrefix}%`}`,
          ),
        ),
      db
        .select({ total: count() })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, userId),
            inArray(usageRecords.capability, ['audio_transcription', 'speech_generation']),
            sql`${usageRecords.recordedDate} like ${`${monthPrefix}%`}`,
          ),
        ),
      db
        .select({ code: referralCodes.code })
        .from(referralCodes)
        .where(eq(referralCodes.ownerUserId, userId))
        .limit(1),
      db
        .select({ total: count() })
        .from(referralRelationships)
        .where(eq(referralRelationships.referrerUserId, userId)),
    ]);

  return {
    todayRequests: todayRow?.total ?? 0,
    monthRequests: monthRow?.total ?? 0,
    monthImages: imgRow?.total ?? 0,
    monthVideos: vidRow?.total ?? 0,
    monthAudio: audRow?.total ?? 0,
    referralCode: refCode?.code ?? null,
    referredCount: refCount?.total ?? 0,
  };
}

export async function getUserReferralDashboard(userId: string) {
  const db = getDb();
  const [[refCode], relationships, rewards] = await Promise.all([
    db
      .select({ code: referralCodes.code })
      .from(referralCodes)
      .where(eq(referralCodes.ownerUserId, userId))
      .limit(1),
    db
      .select({
        id: referralRelationships.id,
        status: referralRelationships.status,
        createdAt: referralRelationships.createdAt,
        qualifiedAt: referralRelationships.qualifiedAt,
      })
      .from(referralRelationships)
      .where(eq(referralRelationships.referrerUserId, userId))
      .orderBy(desc(referralRelationships.createdAt))
      .limit(20),
    db
      .select({
        creditsAwarded: referralRewards.creditsAwarded,
        subscriptionDaysAwarded: referralRewards.subscriptionDaysAwarded,
        status: referralRewards.status,
        awardedAt: referralRewards.awardedAt,
      })
      .from(referralRewards)
      .where(eq(referralRewards.beneficiaryUserId, userId))
      .orderBy(desc(referralRewards.createdAt))
      .limit(20),
  ]);

  const totalInvited = relationships.length;
  const qualifiedCount = relationships.filter((r) => r.status === 'rewarded' || r.status === 'qualified').length;
  const pendingCount = relationships.filter((r) => r.status === 'pending').length;
  const earnedCredits = rewards
    .filter((r) => r.status === 'awarded')
    .reduce((sum, r) => sum + Number(r.creditsAwarded ?? 0), 0);
  const earnedDays = rewards
    .filter((r) => r.status === 'awarded')
    .reduce((sum, r) => sum + Number(r.subscriptionDaysAwarded ?? 0), 0);

  return {
    referralCode: refCode?.code ?? null,
    totalInvited,
    qualifiedCount,
    pendingCount,
    earnedCredits,
    earnedDays,
    recentRelationships: relationships.slice(0, 5),
  };
}

export async function getUserRecentPayments(userId: string) {
  const db = getDb();
  return db
    .select({
      id: payments.id,
      orderNumber: payments.orderNumber,
      paymentType: payments.paymentType,
      amount: payments.amount,
      currency: payments.currency,
      status: payments.status,
      refundStatus: payments.refundStatus,
      isRecurring: payments.isRecurring,
      paidAt: payments.paidAt,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(eq(payments.userId, userId))
    .orderBy(desc(payments.createdAt))
    .limit(10);
}
