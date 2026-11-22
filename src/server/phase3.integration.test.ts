import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/index.ts';
import {
  adminUsers,
  aiModels,
  aiProviders,
  coupons,
  creditPackages,
  creditTransactions,
  creditWallets,
  modelCapabilities,
  notificationLogs,
  payments,
  providerCredentials,
  referralCodes,
  referralProgramSettings,
  referralRelationships,
  subscriptionPlans,
  systemSettings,
  userLimitOverrides,
  users,
  userSubscriptions,
} from '../db/schema.ts';
import { createApiApp } from './app.ts';
import { ensurePlatformReady } from './services/bootstrap.ts';
import { encryptSecret, maskSecret } from './security/crypto.ts';
import { hashPassword } from './security/password.ts';
import { ensureTelegramUser } from './telegram/userService.ts';
import {
  createTelegramStarsOrder,
  processSuccessfulTelegramPayment,
  refundTelegramStarsPayment,
  setRefundStarHookForTests,
  validateTelegramPreCheckout,
} from './services/telegramStarsService.ts';
import {
  activateOrRenewSubscription,
  cancelSubscriptionAutoRenewal,
  runSubscriptionExpirationSweep,
  setEditStarSubscriptionHookForTests,
} from './services/subscriptionService.ts';
import {
  applyWalletCreditChange,
  WalletError,
} from './services/walletService.ts';
import {
  attributeReferralSignup,
  redeemGiftCreditCoupon,
  validateDiscountCouponForCheckout,
} from './services/referralCouponService.ts';
import {
  reconcileRequestSuccess,
  reserveCreditsAndCreateRequest,
  UsageGuardError,
} from './services/usageService.ts';
import { loadModelExecutionRoute } from './providers/engine.ts';
import { setNotificationSenderForTests } from './services/notificationService.ts';
import { subscriptionPlanSchema } from '../shared/validation.ts';

let server: http.Server;
let baseUrl = '';
let testSuperAdminId = '';

const sentNotifications: Array<{ chatId: number; text: string }> = [];
const refundCalls: Array<{ telegramUserId: number; telegramPaymentChargeId: string }> = [];
const editSubCalls: Array<{ telegramUserId: number; telegramChargeId: string; isCanceled: boolean }> = [];

async function httpJson(
  path: string,
  options?: { method?: string; headers?: Record<string, string>; body?: unknown },
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options?.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-json
  }
  return { status: res.status, json, headers: res.headers };
}

async function loginAdmin(email: string, password: string) {
  const res = await httpJson('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  expect(res.status).toBe(200);
  const rawCookie = res.headers.get('set-cookie') ?? '';
  const cookiePair = rawCookie.split(';')[0] ?? '';
  const csrfToken = String(res.json.csrfToken ?? '');
  return { cookie: cookiePair, csrfToken };
}

beforeAll(async () => {
  process.env.AI_MOCK_MODE = 'true';
  process.env.ENCRYPTION_MASTER_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.PAYMENT_PAYLOAD_SECRET =
    'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  process.env.CRON_SECRET = 'cron_test_secret_phase3_999999';

  await ensurePlatformReady();

  // Seed one super_admin for refund/audit tests
  const db = getDb();
  const passHash = await hashPassword('StrongPhase3Pass!2026');
  const [sa] = await db
    .insert(adminUsers)
    .values({
      email: `p3-bootstrap-${Date.now()}@hooshnegar.test`,
      fullName: 'Phase3 Refund Admin',
      passwordHash: passHash,
      role: 'super_admin',
      status: 'active',
    })
    .returning();
  testSuperAdminId = sa!.id;

  setNotificationSenderForTests(async (chatId, text) => {
    sentNotifications.push({ chatId, text });
  });

  setRefundStarHookForTests(async (params) => {
    refundCalls.push(params);
    return true;
  });

  setEditStarSubscriptionHookForTests(async (params) => {
    editSubCalls.push(params);
    return true;
  });

  const app = createApiApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
}, 30000);

afterAll(async () => {
  setNotificationSenderForTests(null);
  setRefundStarHookForTests(null);
  setEditStarSubscriptionHookForTests(null);
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('Phase 3 Integration — Subscriptions, Telegram Stars, Wallets, Referrals, Failover & RBAC', () => {
  let proPlanId = '';
  let recurringPlanId = '';
  let creditPackId = '';

  // -------------------------------------------------------------------------
  // 1. Subscription plan creation & Stars validation
  // -------------------------------------------------------------------------
  it('1. validates subscription plans and rejects invalid recurring Telegram Stars settings', async () => {
    const tooExpensiveRecurring = subscriptionPlanSchema.safeParse({
      name: 'Invalid Recurring',
      slug: 'invalid-rec',
      tier: 'enterprise',
      currency: 'XTR',
      starsPrice: 3000, // > 2500 max allowed by Telegram Bot API
      isRecurringStars: true,
      durationDays: 30,
      isEnabled: true,
    });
    expect(tooExpensiveRecurring.success).toBe(false);

    const wrongDurationRecurring = subscriptionPlanSchema.safeParse({
      name: 'Invalid Duration',
      slug: 'invalid-dur',
      tier: 'pro',
      currency: 'XTR',
      starsPrice: 200,
      isRecurringStars: true,
      durationDays: 14, // Must be 30 days
      isEnabled: true,
    });
    expect(wrongDurationRecurring.success).toBe(false);

    const db = getDb();
    const [proPlan] = await db
      .insert(subscriptionPlans)
      .values({
        name: 'Pro Stars Plan',
        slug: `pro-stars-${Date.now()}`,
        tier: 'pro',
        description: 'Full commercial pro plan',
        priceAmount: '300',
        currency: 'XTR',
        starsPrice: 300,
        billingInterval: 'monthly',
        isRecurringStars: false,
        durationDays: 30,
        dailyRequestLimit: 50,
        monthlyRequestLimit: 1000,
        dailyTextLimit: 40,
        textGenerationLimit: 800,
        dailyImageLimit: 10,
        imageGenerationLimit: 100,
        audioGenerationLimit: 50,
        dailyVideoLimit: 2,
        videoGenerationLimit: 10,
        maxFileSizeMb: 25,
        maxContextLength: 32000,
        maxConcurrentTasks: 3,
        creditAllocation: 500,
        priorityQueue: true,
        isEnabled: true,
      })
      .returning();
    proPlanId = proPlan!.id;

    const [recPlan] = await db
      .insert(subscriptionPlans)
      .values({
        name: 'Premium Auto-Renew Stars',
        slug: `prem-rec-${Date.now()}`,
        tier: 'premium',
        priceAmount: '500',
        currency: 'XTR',
        starsPrice: 500,
        billingInterval: 'monthly',
        isRecurringStars: true,
        durationDays: 30,
        creditAllocation: 1000,
        priorityQueue: true,
        isEnabled: true,
      })
      .returning();
    recurringPlanId = recPlan!.id;

    const [pack] = await db
      .insert(creditPackages)
      .values({
        name: 'Top-Up 250',
        slug: `pack-250-${Date.now()}`,
        creditsAmount: 250,
        bonusCredits: 50,
        starsPrice: 100,
        isActive: true,
      })
      .returning();
    creditPackId = pack!.id;

    expect(proPlanId).toBeTruthy();
    expect(recurringPlanId).toBeTruthy();
    expect(creditPackId).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 2. Subscription expiration sweep (automatic transition + notification)
  // -------------------------------------------------------------------------
  it('2. automatically expires overdue subscriptions via scheduled sweep and notifies once', async () => {
    const db = getDb();
    const u = await ensureTelegramUser({
      telegramUserId: 930001,
      telegramChatId: 930001,
      username: 'expiring_user',
      firstName: 'Expiring',
    });

    const pastStart = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const pastEnd = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const [sub] = await db
      .insert(userSubscriptions)
      .values({
        userId: u.user.id,
        planId: proPlanId,
        status: 'active',
        startsAt: pastStart,
        endsAt: pastEnd,
        autoRenew: false,
      })
      .returning();

    const firstSweep = await runSubscriptionExpirationSweep();
    expect(firstSweep.expiredCount).toBeGreaterThanOrEqual(1);

    const [updatedSub] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, sub!.id))
      .limit(1);
    expect(updatedSub?.status).toBe('expired');

    // Second sweep must be idempotent (no duplicate notification)
    const beforeNotifs = sentNotifications.filter((n) => n.chatId === 930001).length;
    expect(beforeNotifs).toBe(1);
    await runSubscriptionExpirationSweep();
    const afterNotifs = sentNotifications.filter((n) => n.chatId === 930001).length;
    expect(afterNotifs).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3. Recurring billing events (is_first_recurring + subsequent renewal + cancel)
  // -------------------------------------------------------------------------
  it('3. handles recurring Stars subscription activation, subsequent renewal, and cancellation', async () => {
    const db = getDb();
    const u = await ensureTelegramUser({
      telegramUserId: 930002,
      telegramChatId: 930002,
      username: 'recurring_buyer',
      firstName: 'Recurring',
    });

    const order = await createTelegramStarsOrder({
      userId: u.user.id,
      telegramUserId: 930002,
      kind: 'subscription',
      planId: recurringPlanId,
    });
    expect(order.currency).toBe('XTR');
    expect(order.providerToken).toBe('');
    expect(order.isRecurring).toBe(true);
    expect(order.subscriptionPeriodSeconds).toBe(2592000);

    const firstExp = Math.floor(Date.now() / 1000) + 2592000;
    const firstPay = await processSuccessfulTelegramPayment({
      telegramUserId: 930002,
      currency: 'XTR',
      totalAmount: 500,
      invoicePayload: order.invoicePayload,
      telegramPaymentChargeId: 'tg_charge_rec_1',
      isRecurring: true,
      isFirstRecurring: true,
      subscriptionExpirationDate: firstExp,
    });
    expect(firstPay.ok).toBe(true);
    expect(firstPay.duplicate).toBe(false);

    // Subsequent renewal event arrives with SAME invoice_payload and NEW charge_id
    const secondExp = firstExp + 2592000;
    const renewalPay = await processSuccessfulTelegramPayment({
      telegramUserId: 930002,
      currency: 'XTR',
      totalAmount: 500,
      invoicePayload: order.invoicePayload,
      telegramPaymentChargeId: 'tg_charge_rec_2',
      isRecurring: true,
      isFirstRecurring: false,
      subscriptionExpirationDate: secondExp,
    });
    expect(renewalPay.ok).toBe(true);
    expect(renewalPay.duplicate).toBe(false);
    expect(renewalPay.paymentId).not.toBe(firstPay.paymentId);

    const [sub] = await db
      .select()
      .from(userSubscriptions)
      .where(and(eq(userSubscriptions.userId, u.user.id), eq(userSubscriptions.status, 'active')))
      .limit(1);
    expect(sub?.autoRenew).toBe(true);
    expect(Math.floor(sub!.endsAt.getTime() / 1000)).toBe(secondExp);

    // Cancel auto-renewal via editUserStarSubscription hook
    const cancelRes = await cancelSubscriptionAutoRenewal({ userId: u.user.id });
    expect(cancelRes.ok).toBe(true);
    expect(editSubCalls.some((c) => c.telegramUserId === 930002 && c.isCanceled)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4 & 5. Telegram Stars pre_checkout validation, settlement & duplicate prevention
  // -------------------------------------------------------------------------
  it('4 & 5. validates pre_checkout_query strictly and prevents duplicate payment double-crediting', async () => {
    const db = getDb();
    const u = await ensureTelegramUser({
      telegramUserId: 930003,
      telegramChatId: 930003,
      username: 'pack_buyer',
      firstName: 'PackBuyer',
    });

    const order = await createTelegramStarsOrder({
      userId: u.user.id,
      telegramUserId: 930003,
      kind: 'credit_package',
      creditPackageId: creditPackId,
    });

    // Reject non-XTR currency
    const wrongCurrency = await validateTelegramPreCheckout({
      preCheckoutQueryId: 'pcq_bad_cur',
      telegramUserId: 930003,
      currency: 'USD',
      totalAmount: 100,
      invoicePayload: order.invoicePayload,
    });
    expect(wrongCurrency.ok).toBe(false);

    // Reject tampered amount
    const wrongAmount = await validateTelegramPreCheckout({
      preCheckoutQueryId: 'pcq_bad_amt',
      telegramUserId: 930003,
      currency: 'XTR',
      totalAmount: 1,
      invoicePayload: order.invoicePayload,
    });
    expect(wrongAmount.ok).toBe(false);

    // Approve valid pre_checkout_query
    const validPre = await validateTelegramPreCheckout({
      preCheckoutQueryId: 'pcq_ok_1',
      telegramUserId: 930003,
      currency: 'XTR',
      totalAmount: 100,
      invoicePayload: order.invoicePayload,
    });
    expect(validPre.ok).toBe(true);

    const [walletBefore] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, u.user.id));
    const startBal = Number(walletBefore?.balance ?? 0);

    // First settlement grants 250 + 50 = 300 credits
    const first = await processSuccessfulTelegramPayment({
      telegramUserId: 930003,
      currency: 'XTR',
      totalAmount: 100,
      invoicePayload: order.invoicePayload,
      telegramPaymentChargeId: 'tg_charge_pack_dup_01',
    });
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBe(false);

    // Replay same telegram_payment_charge_id -> must NOT double-credit
    const replay = await processSuccessfulTelegramPayment({
      telegramUserId: 930003,
      currency: 'XTR',
      totalAmount: 100,
      invoicePayload: order.invoicePayload,
      telegramPaymentChargeId: 'tg_charge_pack_dup_01',
    });
    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);

    const [walletAfter] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, u.user.id));
    expect(Number(walletAfter?.balance ?? 0)).toBe(startBal + 300);
  });

  // -------------------------------------------------------------------------
  // 6. Official Telegram Stars refund processing
  // -------------------------------------------------------------------------
  it('6. executes official Telegram Stars refund, claws back credits, and updates status', async () => {
    const db = getDb();
    const [paidOrder] = await db
      .select()
      .from(payments)
      .where(eq(payments.telegramPaymentChargeId, 'tg_charge_pack_dup_01'))
      .limit(1);
    expect(paidOrder).toBeTruthy();

    const [walletBefore] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, paidOrder!.userId));

    const refundRes = await refundTelegramStarsPayment({
      paymentId: paidOrder!.id,
      reason: 'User requested refund via /paysupport',
      revokeBenefits: true,
      adminUserId: testSuperAdminId,
      actorEmail: 'admin@hooshnegar.test',
    });
    expect(refundRes.ok).toBe(true);
    expect(refundCalls.some((r) => r.telegramPaymentChargeId === 'tg_charge_pack_dup_01')).toBe(true);

    const [afterPay] = await db.select().from(payments).where(eq(payments.id, paidOrder!.id));
    expect(afterPay?.status).toBe('refunded');
    expect(afterPay?.refundStatus).toBe('refunded');

    const [walletAfter] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, paidOrder!.userId));
    expect(Number(walletAfter?.balance ?? 0)).toBe(Number(walletBefore?.balance ?? 0) - 300);
  });

  // -------------------------------------------------------------------------
  // 7 & 8. Credit wallet auditability, negative-balance block & concurrent reservation safety
  // -------------------------------------------------------------------------
  it('7 & 8. enforces auditable balanceBefore/balanceAfter, blocks negative balance, and prevents concurrent overspending', async () => {
    const db = getDb();
    const u = await ensureTelegramUser({
      telegramUserId: 930004,
      telegramChatId: 930004,
      username: 'wallet_race_user',
      firstName: 'WalletRace',
    });

    // Reset balance to exact 10 credits
    await db
      .update(creditWallets)
      .set({ balance: '10', reservedBalance: '0' })
      .where(eq(creditWallets.userId, u.user.id));

    // Attempt debit of 15 -> must fail with INSUFFICIENT_BALANCE
    await expect(
      applyWalletCreditChange({
        userId: u.user.id,
        amount: -15,
        type: 'usage_debit',
        idempotencyKey: 'neg_block_test_1',
        description: 'Overdraft attempt',
      }),
    ).rejects.toBeInstanceOf(WalletError);

    // Concurrent race: 5 simultaneous -4 credit debits against 10 credit balance -> at most 2 can succeed!
    const concurrentResults = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((i) =>
        applyWalletCreditChange({
          userId: u.user.id,
          amount: -4,
          type: 'usage_debit',
          idempotencyKey: `race_debit_${i}_${Date.now()}`,
          description: `Race debit ${i}`,
        }),
      ),
    );

    const succeeded = concurrentResults.filter((r) => r.status === 'fulfilled');
    const rejected = concurrentResults.filter((r) => r.status === 'rejected');
    expect(succeeded.length).toBe(2);
    expect(rejected.length).toBe(3);

    const [finalWallet] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, u.user.id));
    expect(Number(finalWallet?.balance ?? -1)).toBe(2);

    const ledgerRows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, u.user.id));
    expect(ledgerRows.some((l) => Number(l.balanceBefore) === 10 && Number(l.balanceAfter) === 6)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 9, 10 & 11. Referral attribution, purchase-qualified rewards & self-referral blocking
  // -------------------------------------------------------------------------
  it('9, 10 & 11. enforces self-referral block, duplicate block, and purchase-qualified referral rewards', async () => {
    const db = getDb();
    await db
      .update(referralProgramSettings)
      .set({
        isActive: true,
        requirePurchase: true,
        inviterRewardType: 'credits',
        inviterBonusCredits: 80,
        invitedBonusCredits: 30,
        minPurchaseStars: 50,
        minPlanTier: 'free',
        updatedAt: new Date(),
      })
      .where(eq(referralProgramSettings.singletonKey, 'primary'));

    const inviter = await ensureTelegramUser({
      telegramUserId: 930005,
      telegramChatId: 930005,
      username: 'inviter_one',
      firstName: 'Inviter',
    });

    const [inviterCode] = await db
      .select()
      .from(referralCodes)
      .where(eq(referralCodes.ownerUserId, inviter.user.id))
      .limit(1);
    expect(inviterCode?.code).toBeTruthy();

    // 11a. Self-referral must be blocked
    const selfAttempt = await attributeReferralSignup({
      referredUserId: inviter.user.id,
      referralCode: inviterCode!.code,
    });
    expect(selfAttempt.attributed).toBe(false);
    expect(selfAttempt.reason).toBe('self_referral_blocked');

    // 9. New user registers with inviter's code
    const [inviterWalletBefore] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, inviter.user.id));
    const inviterBalStart = Number(inviterWalletBefore?.balance ?? 0);

    const invited = await ensureTelegramUser({
      telegramUserId: 930006,
      telegramChatId: 930006,
      username: 'invited_buyer',
      firstName: 'Invited',
      referralCode: inviterCode!.code,
    });

    // 11b. Duplicate referral attribution must be blocked
    const dupAttempt = await attributeReferralSignup({
      referredUserId: invited.user.id,
      referralCode: inviterCode!.code,
    });
    expect(dupAttempt.attributed).toBe(false);
    expect(dupAttempt.reason).toBe('already_referred');

    // 10a. Because requirePurchase=true, relationship stays 'pending' and inviter has NOT been rewarded yet
    const [relBefore] = await db
      .select()
      .from(referralRelationships)
      .where(eq(referralRelationships.referredUserId, invited.user.id))
      .limit(1);
    expect(relBefore?.status).toBe('pending');

    const [inviterWalletMid] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, inviter.user.id));
    expect(Number(inviterWalletMid?.balance ?? 0)).toBe(inviterBalStart);

    // 10b. Invited user completes qualifying Stars purchase (100 XTR >= 50 XTR) -> triggers reward!
    const order = await createTelegramStarsOrder({
      userId: invited.user.id,
      telegramUserId: 930006,
      kind: 'credit_package',
      creditPackageId: creditPackId,
    });
    const payRes = await processSuccessfulTelegramPayment({
      telegramUserId: 930006,
      currency: 'XTR',
      totalAmount: 100,
      invoicePayload: order.invoicePayload,
      telegramPaymentChargeId: 'tg_charge_ref_qual_01',
    });
    expect(payRes.ok).toBe(true);

    const [relAfter] = await db
      .select()
      .from(referralRelationships)
      .where(eq(referralRelationships.referredUserId, invited.user.id))
      .limit(1);
    expect(relAfter?.status).toBe('rewarded');

    const [inviterWalletAfter] = await db
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, inviter.user.id));
    expect(Number(inviterWalletAfter?.balance ?? 0)).toBe(inviterBalStart + 80);
  });

  // -------------------------------------------------------------------------
  // 12. Coupon redemption, server-side checkout discount & perUserLimit / maxRedemptions
  // -------------------------------------------------------------------------
  it('12. validates percentage discount coupons server-side and enforces gift credit perUserLimit', async () => {
    const db = getDb();
    const u = await ensureTelegramUser({
      telegramUserId: 930007,
      telegramChatId: 930007,
      username: 'coupon_tester',
      firstName: 'CouponTester',
    });

    // Percentage discount coupon (20% off)
    const pctCode = `SAVE20_${Date.now().toString().slice(-4)}`;
    await db.insert(coupons).values({
      code: pctCode,
      discountType: 'percentage',
      discountValue: '20',
      maxRedemptions: 10,
      perUserLimit: 1,
      minStarsAmount: 100,
      isActive: true,
    });

    const discountCheck = await validateDiscountCouponForCheckout({
      userId: u.user.id,
      code: pctCode,
      baseStars: 300,
      planId: proPlanId,
    });
    expect(discountCheck.valid).toBe(true);
    expect(discountCheck.discountStars).toBe(60);
    expect(discountCheck.finalStars).toBe(240);

    // Order created with coupon reflects server-calculated discounted Stars price (240 XTR)
    const discountedOrder = await createTelegramStarsOrder({
      userId: u.user.id,
      telegramUserId: 930007,
      kind: 'subscription',
      planId: proPlanId,
      couponCode: pctCode,
    });
    expect(discountedOrder.starsAmount).toBe(240);
    expect(discountedOrder.discountStars).toBe(60);

    // Gift credit coupon with perUserLimit=1
    const giftCode = `GIFT75_${Date.now().toString().slice(-4)}`;
    await db.insert(coupons).values({
      code: giftCode,
      discountType: 'gift_credits',
      discountValue: '75',
      maxRedemptions: 5,
      perUserLimit: 1,
      isActive: true,
    });

    const firstRedeem = await redeemGiftCreditCoupon({ userId: u.user.id, code: giftCode });
    expect(firstRedeem.ok).toBe(true);
    expect(firstRedeem.creditsAwarded).toBe(75);

    // Second redemption by same user must be rejected
    const secondRedeem = await redeemGiftCreditCoupon({ userId: u.user.id, code: giftCode });
    expect(secondRedeem.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 13, 14 & 15. Plan usage limits, user suspension, and safe provider failover guard
  // -------------------------------------------------------------------------
  it('13, 14 & 15. enforces plan model tier gates, limit overrides, suspension, and safe failover guard', async () => {
    const db = getDb();

    // Create provider + credentials
    const [prov] = await db
      .insert(aiProviders)
      .values({
        name: 'Phase3 Test Provider',
        slug: `phase3-test-provider-${Date.now()}`,
        providerType: 'openai_compatible',
        baseUrl: 'https://api.openai.com/v1',
        isActive: true,
      })
      .returning();

    const enc = encryptSecret('sk-phase3-test-key-000011112222');
    await db.insert(providerCredentials).values({
      providerId: prov!.id,
      label: 'primary',
      encryptedApiKey: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      maskedPreview: maskSecret('sk-phase3-test-key-000011112222'),
      keyVersion: 1,
      isActive: true,
    });

    // Expensive fallback model (creditCost = 50)
    const [expensiveFallback] = await db
      .insert(aiModels)
      .values({
        providerId: prov!.id,
        name: 'Expensive Model',
        modelIdentifier: `expensive-${Date.now()}`,
        category: 'llm',
        creditCost: '50',
        minCreditCost: '50',
        providerCostPerOpUsd: '0.25',
        isActive: true,
      })
      .returning();

    // Cheap primary model with fallback pointing to expensiveFallback
    const [primaryModel] = await db
      .insert(aiModels)
      .values({
        providerId: prov!.id,
        name: 'Primary Pro Model',
        modelIdentifier: `primary-pro-${Date.now()}`,
        category: 'llm',
        creditCost: '2',
        minCreditCost: '3', // minCreditCost floor > creditCost -> should charge 3
        providerCostPerOpUsd: '0.005',
        allowedPlanTiers: ['pro', 'premium', 'enterprise'],
        fallbackProviderId: prov!.id,
        fallbackModelIdentifier: expensiveFallback!.modelIdentifier,
        isActive: true,
      })
      .returning();

    await db.insert(modelCapabilities).values([
      { modelId: expensiveFallback!.id, capability: 'text_generation' },
      { modelId: primaryModel!.id, capability: 'text_generation' },
    ]);

    // 15. Safe Failover Guard: primary costs 3, fallback costs 50 -> failover MUST BE BLOCKED!
    const route = await loadModelExecutionRoute(primaryModel!.id, {
      requiredCapability: 'text_generation',
      userPlanTier: 'pro',
    });
    expect(route.fallback).toBeNull();

    // 13a. Plan tier restriction: Free user cannot access a ['pro', 'premium', 'enterprise'] model
    const freeUser = await ensureTelegramUser({
      telegramUserId: 930008,
      telegramChatId: 930008,
      username: 'tier_check_user',
      firstName: 'TierCheck',
    });
    await db
      .update(creditWallets)
      .set({ balance: '100' })
      .where(eq(creditWallets.userId, freeUser.user.id));

    await expect(
      reserveCreditsAndCreateRequest({
        userId: freeUser.user.id,
        modelId: primaryModel!.id,
        capability: 'text_generation',
        idempotencyKey: `tier_block_${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_ALLOWED' });

    // 13b. Assign Pro plan + override dailyTextLimit=1 -> 1st succeeds (charges minCreditCost=3), 2nd blocked
    await activateOrRenewSubscription({
      userId: freeUser.user.id,
      planId: proPlanId,
      grantCredits: false,
      idempotencyKey: `assign_pro_test_${Date.now()}`,
    });
    await db.insert(userLimitOverrides).values({
      userId: freeUser.user.id,
      dailyTextLimit: 1,
      reason: 'Unit test cap',
    });

    const firstReq = await reserveCreditsAndCreateRequest({
      userId: freeUser.user.id,
      modelId: primaryModel!.id,
      capability: 'text_generation',
      idempotencyKey: `cap_ok_${Date.now()}`,
    });
    expect(firstReq.reservedCredits).toBe(3); // minCreditCost floor applied

    await reconcileRequestSuccess({
      requestId: firstReq.requestId,
      jobId: firstReq.jobId,
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 120,
    });

    await expect(
      reserveCreditsAndCreateRequest({
        userId: freeUser.user.id,
        modelId: primaryModel!.id,
        capability: 'text_generation',
        idempotencyKey: `cap_block_${Date.now()}`,
      }),
    ).rejects.toBeInstanceOf(UsageGuardError);

    // 14. User suspension enforcement -> immediately blocks AI requests
    await db
      .update(users)
      .set({ status: 'suspended' })
      .where(eq(users.id, freeUser.user.id));

    await expect(
      reserveCreditsAndCreateRequest({
        userId: freeUser.user.id,
        modelId: primaryModel!.id,
        capability: 'text_generation',
        idempotencyKey: `suspended_block_${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: 'USER_SUSPENDED' });
  });

  // -------------------------------------------------------------------------
  // 16. Security, RBAC permissions, Finance API, CSV Formula Safety & Cron Auth
  // -------------------------------------------------------------------------
  it('16. enforces RBAC (auditor vs super_admin), Finance summary/CSV safety, and Cron Bearer auth', async () => {
    const db = getDb();

    const pass = 'StrongPhase3Pass!2026';
    const passHash = await hashPassword(pass);
    const auditorEmail = `auditor-${Date.now()}@hooshnegar.test`;
    const superEmail = `super-${Date.now()}@hooshnegar.test`;

    await db.insert(adminUsers).values([
      {
        email: auditorEmail,
        fullName: 'Test Auditor',
        passwordHash: passHash,
        role: 'auditor',
        status: 'active',
      },
      {
        email: superEmail,
        fullName: 'Test Super Admin',
        passwordHash: passHash,
        role: 'super_admin',
        status: 'active',
      },
    ]);

    const auditorAuth = await loginAdmin(auditorEmail, pass);
    const superAuth = await loginAdmin(superEmail, pass);

    // Auditor can read Finance Summary, but CANNOT create credit packages
    const finRead = await httpJson('/api/finance/summary', {
      headers: { Cookie: auditorAuth.cookie },
    });
    expect(finRead.status).toBe(200);
    expect((finRead.json.kpis as Record<string, unknown>).isEstimatedCost).toBe(true);

    const auditorCreatePack = await httpJson('/api/credit-packages', {
      method: 'POST',
      headers: {
        Cookie: auditorAuth.cookie,
        'X-CSRF-Token': auditorAuth.csrfToken,
      },
      body: {
        name: 'Forbidden Pack',
        slug: 'forbidden-pack',
        creditsAmount: 100,
        starsPrice: 50,
      },
    });
    expect(auditorCreatePack.status).toBe(403);

    // Super admin CAN access CSV export
    const csvRes = await fetch(`${baseUrl}/api/finance/export.csv`, {
      headers: { Cookie: superAuth.cookie },
    });
    expect(csvRes.status).toBe(200);
    const csvText = await csvRes.text();
    expect(csvText).toContain('order_number');

    // Cron endpoint rejects missing/invalid Bearer secret with 401 and accepts valid CRON_SECRET
    const cronUnauth = await httpJson('/api/cron/maintenance', { method: 'GET' });
    expect(cronUnauth.status).toBe(401);

    const cronAuth = await httpJson('/api/cron/maintenance', {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    expect(cronAuth.status).toBe(200);
    expect(cronAuth.json.ok).toBe(true);

    // Verify notification logs persisted for earlier notifications
    const logs = await db.select().from(notificationLogs);
    expect(logs.length).toBeGreaterThan(0);

    // Ensure system settings allowNegativeBalance remains false by default
    const [negSetting] = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.settingKey, 'allowNegativeBalance'));
    expect(negSetting?.value).toBe(false);
  });
});
