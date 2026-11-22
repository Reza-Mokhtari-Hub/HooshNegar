import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  couponRedemptions,
  coupons,
  referralCodes,
  referralProgramSettings,
  referralRelationships,
  referralRewards,
  userSubscriptions,
} from '../../db/schema.ts';
import { applyWalletCreditChange } from './walletService.ts';
import { sendUserNotification } from './notificationService.ts';

const TIER_RANK: Record<string, number> = {
  free: 0,
  basic: 1,
  pro: 2,
  premium: 3,
  enterprise: 4,
  custom: 2,
};

export async function getReferralProgramConfig() {
  const db = getDb();
  let [row] = await db
    .select()
    .from(referralProgramSettings)
    .where(eq(referralProgramSettings.singletonKey, 'primary'))
    .limit(1);

  if (!row) {
    const [created] = await db
      .insert(referralProgramSettings)
      .values({ singletonKey: 'primary' })
      .onConflictDoNothing()
      .returning();
    row = created;
  }

  return (
    row ?? {
      id: '',
      singletonKey: 'primary',
      isActive: true,
      inviterRewardType: 'credits',
      inviterBonusCredits: 50,
      inviterFreeDays: 0,
      invitedBonusCredits: 25,
      requirePurchase: false,
      minPurchaseStars: 0,
      minPlanTier: 'free',
      maxReferralsPerAccount: 100,
      maxRewardCreditsPerAccount: 10000,
      fraudVelocityLimitPerHour: 10,
      campaignStartsAt: null,
      campaignEndsAt: null,
      updatedAt: new Date(),
    }
  );
}

/**
 * Attributes a new user to a referral code during signup (/start).
 * Prevents self-referral, duplicate attribution, expired campaigns, and suspicious velocity.
 * If `requirePurchase` is false, awards signup bonuses immediately; otherwise marks `pending`
 * until the invited user completes a verified qualifying Telegram Stars purchase.
 */
export async function attributeReferralSignup(params: {
  referredUserId: string;
  referralCode: string;
}): Promise<{ attributed: boolean; reason?: string; immediateAward?: boolean }> {
  const db = getDb();
  const config = await getReferralProgramConfig();
  if (!config.isActive) {
    return { attributed: false, reason: 'program_disabled' };
  }

  const now = new Date();
  if (config.campaignStartsAt && now < config.campaignStartsAt) {
    return { attributed: false, reason: 'campaign_not_started' };
  }
  if (config.campaignEndsAt && now > config.campaignEndsAt) {
    return { attributed: false, reason: 'campaign_ended' };
  }

  const cleanCode = params.referralCode.trim().toUpperCase();
  const [refCode] = await db
    .select()
    .from(referralCodes)
    .where(and(eq(referralCodes.code, cleanCode), eq(referralCodes.isActive, true)))
    .limit(1);

  if (!refCode) {
    return { attributed: false, reason: 'invalid_code' };
  }
  if (refCode.expiresAt && refCode.expiresAt < now) {
    return { attributed: false, reason: 'code_expired' };
  }
  if (refCode.maxUses !== null && refCode.usedCount >= refCode.maxUses) {
    return { attributed: false, reason: 'code_max_uses' };
  }

  // Admin campaign referral code (no ownerUserId): award signup credits directly to invited user
  if (!refCode.ownerUserId) {
    if (refCode.rewardCredits > 0) {
      await applyWalletCreditChange({
        userId: params.referredUserId,
        amount: refCode.rewardCredits,
        type: 'referral_bonus',
        idempotencyKey: `campaign_ref:${refCode.id}:${params.referredUserId}`,
        description: `پاداش کد معرفی کمپین ${refCode.code}`,
        referenceType: 'referral_code',
        referenceId: refCode.id,
      });
    }
    await db
      .update(referralCodes)
      .set({ usedCount: refCode.usedCount + 1, updatedAt: now })
      .where(eq(referralCodes.id, refCode.id));
    return { attributed: true, immediateAward: refCode.rewardCredits > 0 };
  }

  // Strictly block self-referral
  if (refCode.ownerUserId === params.referredUserId) {
    return { attributed: false, reason: 'self_referral_blocked' };
  }

  // Strictly prevent duplicate referral attribution per user
  const [alreadyReferred] = await db
    .select({ id: referralRelationships.id })
    .from(referralRelationships)
    .where(eq(referralRelationships.referredUserId, params.referredUserId))
    .limit(1);

  if (alreadyReferred) {
    return { attributed: false, reason: 'already_referred' };
  }

  // Check referrer lifetime limit & hourly velocity fraud score
  const [totalRefsRow] = await db
    .select({ total: count() })
    .from(referralRelationships)
    .where(eq(referralRelationships.referrerUserId, refCode.ownerUserId));

  if ((totalRefsRow?.total ?? 0) >= config.maxReferralsPerAccount) {
    return { attributed: false, reason: 'max_referrals_reached' };
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [recentRefsRow] = await db
    .select({ total: count() })
    .from(referralRelationships)
    .where(
      and(
        eq(referralRelationships.referrerUserId, refCode.ownerUserId),
        gte(referralRelationships.createdAt, oneHourAgo),
      ),
    );

  const fraudFlags: string[] = [];
  let fraudScore = 0;
  if ((recentRefsRow?.total ?? 0) >= config.fraudVelocityLimitPerHour) {
    fraudFlags.push('high_hourly_velocity');
    fraudScore += 75;
  }

  const isFlagged = fraudScore >= 70;
  const initialStatus = isFlagged
    ? 'flagged'
    : config.requirePurchase
      ? 'pending'
      : 'rewarded';

  const [rel] = await db
    .insert(referralRelationships)
    .values({
      referralCodeId: refCode.id,
      referrerUserId: refCode.ownerUserId,
      referredUserId: params.referredUserId,
      status: initialStatus,
      qualifiedAt: initialStatus === 'rewarded' ? now : null,
      fraudScore,
      fraudFlags,
    })
    .onConflictDoNothing()
    .returning();

  if (!rel) {
    return { attributed: false, reason: 'duplicate_conflict' };
  }

  await db
    .update(referralCodes)
    .set({ usedCount: refCode.usedCount + 1, updatedAt: now })
    .where(eq(referralCodes.id, refCode.id));

  if (isFlagged) {
    return { attributed: true, reason: 'flagged_for_review', immediateAward: false };
  }

  // Invited user signup welcome bonus (always safe if configured > 0 and not requiring purchase)
  if (!config.requirePurchase) {
    await grantReferralRewards({
      relationshipId: rel.id,
      referrerUserId: refCode.ownerUserId,
      referredUserId: params.referredUserId,
      codeBonusOverride: refCode.rewardCredits,
      config,
      relatedPaymentId: null,
    });
    return { attributed: true, immediateAward: true };
  }

  return { attributed: true, immediateAward: false };
}

async function grantReferralRewards(params: {
  relationshipId: string;
  referrerUserId: string;
  referredUserId: string;
  codeBonusOverride?: number | null;
  config: Awaited<ReturnType<typeof getReferralProgramConfig>>;
  relatedPaymentId: string | null;
}): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const { config } = params;

  // Enforce max reward credits per inviter account
  const [earnedRow] = await db
    .select({
      total: sql<number>`coalesce(sum(${referralRewards.creditsAwarded}), 0)`,
    })
    .from(referralRewards)
    .where(
      and(
        eq(referralRewards.beneficiaryUserId, params.referrerUserId),
        eq(referralRewards.status, 'awarded'),
      ),
    );
  const earnedSoFar = Number(earnedRow?.total ?? 0);

  const rawInviterCredits =
    config.inviterBonusCredits > 0
      ? config.inviterBonusCredits
      : (params.codeBonusOverride ?? 0);
  const inviterCredits =
    config.inviterRewardType === 'subscription_days'
      ? 0
      : Math.max(0, Math.min(rawInviterCredits, Math.max(0, config.maxRewardCreditsPerAccount - earnedSoFar)));

  const inviterDays =
    config.inviterRewardType === 'subscription_days' ? Math.max(0, config.inviterFreeDays) : 0;

  let awardedAnything = false;

  // 1. Reward Inviter
  if (inviterCredits > 0 || inviterDays > 0) {
    const inviterKey = `ref:inviter:${params.relationshipId}`;
    const [rewardRow] = await db
      .insert(referralRewards)
      .values({
        relationshipId: params.relationshipId,
        beneficiaryUserId: params.referrerUserId,
        rewardType: config.inviterRewardType,
        creditsAwarded: inviterCredits,
        subscriptionDaysAwarded: inviterDays,
        relatedPaymentId: params.relatedPaymentId,
        status: 'awarded',
        idempotencyKey: inviterKey,
        awardedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (rewardRow) {
      awardedAnything = true;
      if (inviterCredits > 0) {
        await applyWalletCreditChange({
          userId: params.referrerUserId,
          amount: inviterCredits,
          type:
            config.inviterRewardType === 'promotional_credits'
              ? 'promotional_credit'
              : 'referral_bonus',
          idempotencyKey: `wallet:${inviterKey}`,
          description: 'پاداش معرفی موفق دوست جدید',
          referenceType: 'referral_reward',
          referenceId: rewardRow.id,
          relatedPaymentId: params.relatedPaymentId,
        });
      }

      if (inviterDays > 0) {
        const [activeSub] = await db
          .select()
          .from(userSubscriptions)
          .where(
            and(
              eq(userSubscriptions.userId, params.referrerUserId),
              eq(userSubscriptions.status, 'active'),
            ),
          )
          .orderBy(desc(userSubscriptions.endsAt))
          .limit(1);

        if (activeSub) {
          const baseDate = activeSub.endsAt > now ? activeSub.endsAt : now;
          const extended = new Date(baseDate.getTime() + inviterDays * 24 * 60 * 60 * 1000);
          await db
            .update(userSubscriptions)
            .set({ endsAt: extended, updatedAt: now })
            .where(eq(userSubscriptions.id, activeSub.id));
        }
      }

      const summary =
        inviterDays > 0
          ? `${inviterDays} روز اشتراک هدیه`
          : `${inviterCredits} اعتبار هدیه`;
      await sendUserNotification({
        userId: params.referrerUserId,
        templateKey: 'referral_success',
        dedupKey: `notif:${inviterKey}`,
        variables: { rewardSummary: summary },
      });
    }
  }

  // 2. Reward Invited User
  if (config.invitedBonusCredits > 0) {
    const invitedKey = `ref:invited:${params.relationshipId}`;
    const [invitedRow] = await db
      .insert(referralRewards)
      .values({
        relationshipId: params.relationshipId,
        beneficiaryUserId: params.referredUserId,
        rewardType: 'credits',
        creditsAwarded: config.invitedBonusCredits,
        subscriptionDaysAwarded: 0,
        relatedPaymentId: params.relatedPaymentId,
        status: 'awarded',
        idempotencyKey: invitedKey,
        awardedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (invitedRow) {
      awardedAnything = true;
      await applyWalletCreditChange({
        userId: params.referredUserId,
        amount: config.invitedBonusCredits,
        type: 'referral_bonus',
        idempotencyKey: `wallet:${invitedKey}`,
        description: 'هدیه خوش‌آمدگویی عضویت با لینک دعوت',
        referenceType: 'referral_reward',
        referenceId: invitedRow.id,
        relatedPaymentId: params.relatedPaymentId,
      });
    }
  }

  return awardedAnything;
}

/**
 * Evaluates pending purchase-qualified referrals after a verified Telegram Stars payment.
 */
export async function evaluateReferralRewardsOnPayment(params: {
  userId: string;
  paymentId: string;
  starsAmount: number;
  planTier?: string | null;
}): Promise<{ qualified: boolean; reason?: string }> {
  const db = getDb();
  const config = await getReferralProgramConfig();
  if (!config.isActive) return { qualified: false, reason: 'program_disabled' };

  const [rel] = await db
    .select()
    .from(referralRelationships)
    .where(eq(referralRelationships.referredUserId, params.userId))
    .limit(1);

  if (!rel) return { qualified: false, reason: 'no_referral' };
  if (rel.status === 'rewarded') return { qualified: false, reason: 'already_rewarded' };
  if (rel.status === 'flagged' || rel.fraudScore >= 70) {
    return { qualified: false, reason: 'flagged' };
  }

  if (params.starsAmount < config.minPurchaseStars) {
    return { qualified: false, reason: 'below_min_stars' };
  }

  const requiredRank = TIER_RANK[config.minPlanTier] ?? 0;
  const purchasedRank = params.planTier ? (TIER_RANK[params.planTier] ?? 0) : 1;
  if (requiredRank > 0 && purchasedRank < requiredRank) {
    return { qualified: false, reason: 'below_min_tier' };
  }

  const now = new Date();
  await db
    .update(referralRelationships)
    .set({
      status: 'rewarded',
      qualifiedAt: now,
      qualifyingPaymentId: params.paymentId,
    })
    .where(eq(referralRelationships.id, rel.id));

  await grantReferralRewards({
    relationshipId: rel.id,
    referrerUserId: rel.referrerUserId,
    referredUserId: rel.referredUserId,
    config,
    relatedPaymentId: params.paymentId,
  });

  return { qualified: true };
}

// =============================================================================
// COUPONS, PROMO CODES & GIFT CREDIT CODES (SERVER-SIDE VALIDATION ONLY)
// =============================================================================

export interface CouponValidationResult {
  valid: boolean;
  errorFa?: string;
  couponId?: string;
  code?: string;
  discountType?: string;
  discountStars?: number;
  finalStars?: number;
  creditsBonus?: number;
}

/**
 * Validates a percentage/fixed discount coupon strictly server-side before creating a Stars order.
 */
export async function validateDiscountCouponForCheckout(params: {
  userId: string;
  code: string;
  planId?: string | null;
  baseStars: number;
}): Promise<CouponValidationResult> {
  const db = getDb();
  const cleanCode = params.code.trim().toUpperCase();
  const now = new Date();

  const [coupon] = await db
    .select()
    .from(coupons)
    .where(and(eq(coupons.code, cleanCode), eq(coupons.isActive, true)))
    .limit(1);

  if (!coupon) {
    return { valid: false, errorFa: 'کد تخفیف واردشده معتبر نیست یا غیرفعال شده است.' };
  }
  if (coupon.startsAt && now < coupon.startsAt) {
    return { valid: false, errorFa: 'زمان استفاده از این کد تخفیف هنوز شروع نشده است.' };
  }
  if (coupon.expiresAt && now > coupon.expiresAt) {
    return { valid: false, errorFa: 'مهلت استفاده از این کد تخفیف به پایان رسیده است.' };
  }
  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return { valid: false, errorFa: 'ظرفیت کل استفاده از این کد تخفیف تکمیل شده است.' };
  }
  if (params.baseStars < coupon.minStarsAmount) {
    return {
      valid: false,
      errorFa: `حداقل مبلغ خرید برای استفاده از این کد ${coupon.minStarsAmount} استارز است.`,
    };
  }
  if (
    params.planId &&
    Array.isArray(coupon.applicablePlanIds) &&
    coupon.applicablePlanIds.length > 0 &&
    !coupon.applicablePlanIds.includes(params.planId)
  ) {
    return { valid: false, errorFa: 'این کد تخفیف برای پلن انتخاب‌شده قابل استفاده نیست.' };
  }

  const [userUsesRow] = await db
    .select({ total: count() })
    .from(couponRedemptions)
    .where(and(eq(couponRedemptions.couponId, coupon.id), eq(couponRedemptions.userId, params.userId)));

  if ((userUsesRow?.total ?? 0) >= coupon.perUserLimit) {
    return { valid: false, errorFa: 'شما قبلاً حداکثر دفعات مجاز از این کد استفاده کرده‌اید.' };
  }

  const val = Number(coupon.discountValue);
  if (coupon.discountType === 'percentage') {
    const discountStars = Math.floor((params.baseStars * Math.min(95, Math.max(1, val))) / 100);
    const finalStars = Math.max(1, params.baseStars - discountStars);
    return {
      valid: true,
      couponId: coupon.id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountStars: params.baseStars - finalStars,
      finalStars,
    };
  }

  if (coupon.discountType === 'fixed') {
    const discountStars = Math.min(params.baseStars - 1, Math.floor(val));
    const finalStars = Math.max(1, params.baseStars - Math.max(0, discountStars));
    return {
      valid: true,
      couponId: coupon.id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountStars: params.baseStars - finalStars,
      finalStars,
    };
  }

  return {
    valid: false,
    errorFa: 'این کد از نوع کد اعتبار هدیه است. لطفاً آن را مستقیماً در بخش «🎁 اعمال کد هدیه» وارد کنید.',
  };
}

/**
 * Redeems a gift/promotional/fixed_credits coupon code directly into the user's credit wallet.
 * Enforces maxRedemptions, perUserLimit, expiration, and idempotency atomically.
 */
export async function redeemGiftCreditCoupon(params: {
  userId: string;
  code: string;
}): Promise<{ ok: boolean; errorFa?: string; creditsAwarded?: number; newBalance?: number }> {
  const db = getDb();
  const cleanCode = params.code.trim().toUpperCase();
  const now = new Date();

  const [coupon] = await db
    .select()
    .from(coupons)
    .where(and(eq(coupons.code, cleanCode), eq(coupons.isActive, true)))
    .limit(1);

  if (!coupon) {
    return { ok: false, errorFa: 'کد واردشده معتبر نیست یا غیرفعال است.' };
  }
  if (!['fixed_credits', 'gift_credits', 'promotional'].includes(coupon.discountType)) {
    return {
      ok: false,
      errorFa: 'این کد یک کد تخفیف خرید اشتراک است و هنگام خرید پلن با تلگرام استارز اعمال می‌شود.',
    };
  }
  if (coupon.startsAt && now < coupon.startsAt) {
    return { ok: false, errorFa: 'زمان استفاده از این کد هدیه هنوز فرا نرسیده است.' };
  }
  if (coupon.expiresAt && now > coupon.expiresAt) {
    return { ok: false, errorFa: 'مهلت استفاده از این کد هدیه به پایان رسیده است.' };
  }

  // Atomic check + increment inside transaction
  const reserved = await db.transaction(async (tx) => {
    const [lockedCoupon] = await tx
      .select()
      .from(coupons)
      .where(eq(coupons.id, coupon.id))
      .for('update');

    if (!lockedCoupon || !lockedCoupon.isActive) {
      return { ok: false as const, errorFa: 'کد غیرفعال شده است.' };
    }
    if (
      lockedCoupon.maxRedemptions !== null &&
      lockedCoupon.redeemedCount >= lockedCoupon.maxRedemptions
    ) {
      return { ok: false as const, errorFa: 'ظرفیت استفاده از این کد هدیه تکمیل شده است.' };
    }

    const [userUsesRow] = await tx
      .select({ total: count() })
      .from(couponRedemptions)
      .where(
        and(eq(couponRedemptions.couponId, lockedCoupon.id), eq(couponRedemptions.userId, params.userId)),
      );

    const usedByUser = userUsesRow?.total ?? 0;
    if (usedByUser >= lockedCoupon.perUserLimit) {
      return { ok: false as const, errorFa: 'شما قبلاً از این کد هدیه استفاده کرده‌اید.' };
    }

    const creditsToAdd = Math.max(1, Math.floor(Number(lockedCoupon.discountValue)));
    const redemptionKey = `coupon:${lockedCoupon.id}:${params.userId}:${usedByUser + 1}`;

    const [redemption] = await tx
      .insert(couponRedemptions)
      .values({
        couponId: lockedCoupon.id,
        userId: params.userId,
        creditsAwarded: creditsToAdd,
        discountApplied: '0',
        idempotencyKey: redemptionKey,
      })
      .onConflictDoNothing()
      .returning();

    if (!redemption) {
      return { ok: false as const, errorFa: 'این کد قبلاً برای شما ثبت شده است.' };
    }

    await tx
      .update(coupons)
      .set({
        redeemedCount: lockedCoupon.redeemedCount + 1,
        updatedAt: now,
      })
      .where(eq(coupons.id, lockedCoupon.id));

    return {
      ok: true as const,
      creditsToAdd,
      redemptionId: redemption.id,
      redemptionKey,
      code: lockedCoupon.code,
    };
  });

  if (!reserved.ok) {
    return { ok: false, errorFa: reserved.errorFa };
  }

  const walletRes = await applyWalletCreditChange({
    userId: params.userId,
    amount: reserved.creditsToAdd,
    type: 'promotional_credit',
    idempotencyKey: `wallet:${reserved.redemptionKey}`,
    description: `دریافت اعتبار هدیه با کد ${reserved.code}`,
    referenceType: 'coupon_redemption',
    referenceId: reserved.redemptionId,
  });

  await sendUserNotification({
    userId: params.userId,
    templateKey: 'promo_reward',
    dedupKey: `notif:${reserved.redemptionKey}`,
    variables: {
      creditsAdded: reserved.creditsToAdd,
      reason: `کد هدیه ${reserved.code}`,
      balance: Number(walletRes.balanceAfter.toFixed(2)),
    },
  });

  return {
    ok: true,
    creditsAwarded: reserved.creditsToAdd,
    newBalance: walletRes.balanceAfter,
  };
}
