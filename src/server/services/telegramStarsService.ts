import crypto from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  couponRedemptions,
  coupons,
  creditPackages,
  creditWallets,
  paymentEvents,
  payments,
  subscriptionPlans,
  telegramAccounts,
  userSubscriptions,
} from '../../db/schema.ts';
import { getConfiguredTelegramApi } from '../telegram/jobRunner.ts';
import { recordAuditLog } from '../security/audit.ts';
import { applyWalletCreditChange } from './walletService.ts';
import { activateOrRenewSubscription } from './subscriptionService.ts';
import {
  evaluateReferralRewardsOnPayment,
  validateDiscountCouponForCheckout,
} from './referralCouponService.ts';
import { sendUserNotification } from './notificationService.ts';

export const TELEGRAM_STARS_CURRENCY = 'XTR' as const;
export const TELEGRAM_RECURRING_PERIOD_SECONDS = 2592000 as const; // Official 30-day Telegram Stars recurring period
export const TELEGRAM_MAX_RECURRING_STARS = 2500 as const;

type RefundStarHook = (params: {
  telegramUserId: number;
  telegramPaymentChargeId: string;
}) => Promise<boolean>;

let refundStarHookForTests: RefundStarHook | null = null;

export function setRefundStarHookForTests(hook: RefundStarHook | null): void {
  refundStarHookForTests = hook;
}

function getPayloadSigningSecret(): string {
  return (
    process.env.PAYMENT_PAYLOAD_SECRET?.trim() ||
    process.env.ENCRYPTION_MASTER_KEY?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    'dev-stars-hmac-secret-do-not-use-in-prod'
  );
}

export function signInvoicePayload(payload: string): string {
  return crypto
    .createHmac('sha256', getPayloadSigningSecret())
    .update(payload)
    .digest('hex');
}

export function verifyInvoicePayloadHmac(payload: string, expectedHmac: string): boolean {
  const actual = signInvoicePayload(payload);
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expectedHmac, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `HN-${ts}-${rnd}`;
}

export interface StarsOrderResult {
  paymentId: string;
  orderNumber: string;
  invoicePayload: string;
  title: string;
  description: string;
  currency: 'XTR';
  providerToken: '';
  starsAmount: number;
  discountStars: number;
  isRecurring: boolean;
  subscriptionPeriodSeconds?: number;
  label: string;
}

/**
 * Creates a signed, unique internal order for a Telegram Stars (XTR) subscription
 * or credit package purchase. Never trusts client-provided prices or discounts.
 */
export async function createTelegramStarsOrder(params: {
  userId: string;
  telegramUserId: number;
  kind: 'subscription' | 'credit_package';
  planId?: string;
  creditPackageId?: string;
  couponCode?: string | null;
}): Promise<StarsOrderResult> {
  const db = getDb();

  let title = '';
  let description = '';
  let baseStars = 0;
  let isRecurring = false;
  let planId: string | null = null;
  let creditPackageId: string | null = null;
  let label = '';

  if (params.kind === 'subscription') {
    if (!params.planId) throw new Error('planId is required');
    const [plan] = await db
      .select()
      .from(subscriptionPlans)
      .where(and(eq(subscriptionPlans.id, params.planId), eq(subscriptionPlans.isEnabled, true)))
      .limit(1);

    if (!plan) {
      throw new Error('پلن انتخاب‌شده یافت نشد یا غیرفعال است.');
    }
    if (plan.starsPrice <= 0) {
      throw new Error('این پلن قیمت تلگرام استارز (XTR) ندارد و رایگان است.');
    }
    if (plan.isRecurringStars && (plan.starsPrice > TELEGRAM_MAX_RECURRING_STARS || plan.durationDays !== 30)) {
      throw new Error(
        'اشتراک تمدید خودکار تلگرام استارز باید دقیقاً ۳۰ روزه و حداکثر ۲۵۰۰ استارز باشد.',
      );
    }

    title = `اشتراک ${plan.name}`;
    description =
      plan.description ||
      `دسترسی به پلن ${plan.name} به مدت ${plan.durationDays} روز با ${plan.creditAllocation} اعتبار ماهانه`;
    baseStars = plan.starsPrice;
    isRecurring = Boolean(plan.isRecurringStars);
    planId = plan.id;
    label = `اشتراک ${plan.name} (${plan.durationDays} روز)`;
  } else {
    if (!params.creditPackageId) throw new Error('creditPackageId is required');
    const [pkg] = await db
      .select()
      .from(creditPackages)
      .where(and(eq(creditPackages.id, params.creditPackageId), eq(creditPackages.isActive, true)))
      .limit(1);

    if (!pkg) {
      throw new Error('بسته اعتبار انتخاب‌شده یافت نشد یا غیرفعال است.');
    }

    const totalCredits = pkg.creditsAmount + pkg.bonusCredits;
    title = `بسته اعتبار ${pkg.name}`;
    description =
      pkg.description ||
      `افزایش فوری ${totalCredits} اعتبار به کیف پول هوش مصنوعی شما`;
    baseStars = pkg.starsPrice;
    isRecurring = false;
    creditPackageId = pkg.id;
    label = `${totalCredits} اعتبار هوش مصنوعی`;
  }

  let finalStars = baseStars;
  let discountStars = 0;
  let couponId: string | null = null;

  if (params.couponCode?.trim()) {
    const check = await validateDiscountCouponForCheckout({
      userId: params.userId,
      code: params.couponCode,
      planId,
      baseStars,
    });
    if (!check.valid) {
      throw new Error(check.errorFa ?? 'کد تخفیف معتبر نیست.');
    }
    finalStars = check.finalStars ?? baseStars;
    discountStars = check.discountStars ?? 0;
    couponId = check.couponId ?? null;
  }

  const orderNumber = generateOrderNumber();
  const nonce = crypto.randomBytes(6).toString('hex');
  const invoicePayload = `xtr:${orderNumber}:${nonce}`;
  const hmac = signInvoicePayload(invoicePayload);

  const [payment] = await db
    .insert(payments)
    .values({
      orderNumber,
      userId: params.userId,
      telegramUserId: params.telegramUserId,
      planId,
      creditPackageId,
      paymentType: params.kind,
      gateway: 'telegram_stars',
      invoicePayload,
      invoicePayloadHmac: hmac,
      amount: String(finalStars),
      discountAmount: String(discountStars),
      currency: TELEGRAM_STARS_CURRENCY,
      status: 'pending',
      couponId,
      isRecurring,
      idempotencyKey: `order:${orderNumber}`,
      metadata: {
        baseStars,
        title,
        couponCode: params.couponCode?.trim().toUpperCase() || null,
      },
    })
    .returning();

  if (!payment) {
    throw new Error('خطا در ایجاد سفارش پرداخت.');
  }

  await db.insert(paymentEvents).values({
    paymentId: payment.id,
    eventType: 'invoice_created',
    idempotencyKey: `evt:created:${payment.id}`,
    payload: { orderNumber, finalStars, discountStars, isRecurring, currency: 'XTR' },
    processedAt: new Date(),
  });

  return {
    paymentId: payment.id,
    orderNumber,
    invoicePayload,
    title: title.slice(0, 32),
    description: description.slice(0, 255),
    currency: TELEGRAM_STARS_CURRENCY,
    providerToken: '',
    starsAmount: finalStars,
    discountStars,
    isRecurring,
    subscriptionPeriodSeconds: isRecurring ? TELEGRAM_RECURRING_PERIOD_SECONDS : undefined,
    label: label.slice(0, 32),
  };
}

/**
 * Validates Telegram `pre_checkout_query` quickly (<10s deadline required by Telegram).
 * Verifies currency === 'XTR', HMAC signature, exact Stars amount, ownership, and product status.
 */
export async function validateTelegramPreCheckout(params: {
  preCheckoutQueryId: string;
  telegramUserId: number;
  currency: string;
  totalAmount: number;
  invoicePayload: string;
}): Promise<{ ok: boolean; errorMessage?: string; paymentId?: string }> {
  const db = getDb();

  if (params.currency !== TELEGRAM_STARS_CURRENCY) {
    return { ok: false, errorMessage: 'فقط پرداخت با تلگرام استارز (XTR) پشتیبانی می‌شود.' };
  }

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.invoicePayload, params.invoicePayload))
    .limit(1);

  if (!payment) {
    return { ok: false, errorMessage: 'سفارش پرداخت یافت نشد یا منقضی شده است.' };
  }

  if (
    !payment.invoicePayloadHmac ||
    !verifyInvoicePayloadHmac(params.invoicePayload, payment.invoicePayloadHmac)
  ) {
    await db
      .insert(paymentEvents)
      .values({
        paymentId: payment.id,
        eventType: 'pre_checkout_rejected_hmac',
        idempotencyKey: `evt:pre:${params.preCheckoutQueryId}`,
        payload: { telegramUserId: params.telegramUserId, totalAmount: params.totalAmount },
        processedAt: new Date(),
      })
      .onConflictDoNothing();
    return { ok: false, errorMessage: 'امضای امنیتی سفارش نامعتبر است.' };
  }

  if (payment.telegramUserId && payment.telegramUserId !== params.telegramUserId) {
    return { ok: false, errorMessage: 'این فاکتور متعلق به حساب تلگرام دیگری است.' };
  }

  if (payment.status !== 'pending' && !payment.isRecurring) {
    return { ok: false, errorMessage: 'این سفارش قبلاً پردازش یا لغو شده است.' };
  }

  const expectedAmount = Math.round(Number(payment.amount));
  if (expectedAmount !== params.totalAmount) {
    await db
      .insert(paymentEvents)
      .values({
        paymentId: payment.id,
        eventType: 'pre_checkout_rejected_amount',
        idempotencyKey: `evt:pre:${params.preCheckoutQueryId}`,
        payload: { expectedAmount, receivedAmount: params.totalAmount },
        processedAt: new Date(),
      })
      .onConflictDoNothing();
    return { ok: false, errorMessage: 'مبلغ پرداختی با مبلغ سفارش مطابقت ندارد.' };
  }

  // Verify product is still active
  if (payment.planId) {
    const [plan] = await db
      .select({ isEnabled: subscriptionPlans.isEnabled })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, payment.planId))
      .limit(1);
    if (!plan?.isEnabled) {
      return { ok: false, errorMessage: 'پلن انتخاب‌شده در حال حاضر غیرفعال است.' };
    }
  } else if (payment.creditPackageId) {
    const [pkg] = await db
      .select({ isActive: creditPackages.isActive })
      .from(creditPackages)
      .where(eq(creditPackages.id, payment.creditPackageId))
      .limit(1);
    if (!pkg?.isActive) {
      return { ok: false, errorMessage: 'بسته اعتبار انتخاب‌شده در حال حاضر غیرفعال است.' };
    }
  }

  await db
    .insert(paymentEvents)
    .values({
      paymentId: payment.id,
      eventType: 'pre_checkout_approved',
      idempotencyKey: `evt:pre:${params.preCheckoutQueryId}`,
      payload: { totalAmount: params.totalAmount, currency: params.currency },
      processedAt: new Date(),
    })
    .onConflictDoNothing();

  return { ok: true, paymentId: payment.id };
}

export interface SuccessfulStarsPaymentInput {
  telegramUserId: number;
  currency: string;
  totalAmount: number;
  invoicePayload: string;
  telegramPaymentChargeId: string;
  providerPaymentChargeId?: string;
  isRecurring?: boolean;
  isFirstRecurring?: boolean;
  subscriptionExpirationDate?: number; // Unix seconds from Telegram
}

/**
 * Atomically and idempotently settles a verified Telegram `successful_payment` update.
 * Supports one-time subscriptions, credit packages, and recurring Stars renewals.
 * Duplicate `telegram_payment_charge_id` deliveries are safely ignored without double-granting.
 */
export async function processSuccessfulTelegramPayment(
  input: SuccessfulStarsPaymentInput,
): Promise<{
  ok: boolean;
  duplicate: boolean;
  paymentId?: string;
  orderNumber?: string;
  itemName?: string;
  newBalance?: number;
  error?: string;
}> {
  const db = getDb();

  if (input.currency !== TELEGRAM_STARS_CURRENCY) {
    return { ok: false, duplicate: false, error: 'Unsupported currency (only XTR allowed)' };
  }

  // 1. Strict idempotency by telegram_payment_charge_id
  const [alreadyByCharge] = await db
    .select()
    .from(payments)
    .where(eq(payments.telegramPaymentChargeId, input.telegramPaymentChargeId))
    .limit(1);

  if (alreadyByCharge) {
    return {
      ok: true,
      duplicate: true,
      paymentId: alreadyByCharge.id,
      orderNumber: alreadyByCharge.orderNumber ?? undefined,
    };
  }

  // 2. Locate original pending order by signed invoicePayload
  const [originalOrder] = await db
    .select()
    .from(payments)
    .where(eq(payments.invoicePayload, input.invoicePayload))
    .limit(1);

  if (!originalOrder) {
    return { ok: false, duplicate: false, error: 'Original payment order not found' };
  }

  if (
    !originalOrder.invoicePayloadHmac ||
    !verifyInvoicePayloadHmac(input.invoicePayload, originalOrder.invoicePayloadHmac)
  ) {
    return { ok: false, duplicate: false, error: 'Invalid HMAC signature on invoice payload' };
  }

  const now = new Date();
  const expirationDate = input.subscriptionExpirationDate
    ? new Date(input.subscriptionExpirationDate * 1000)
    : null;

  // Handle subsequent recurring renewal payments (Telegram sends the same invoice_payload with a NEW charge_id)
  let targetPayment = originalOrder;
  const isSubsequentRenewal =
    originalOrder.status === 'succeeded' &&
    Boolean(input.isRecurring) &&
    !input.isFirstRecurring;

  if (isSubsequentRenewal) {
    const renewalOrderNumber = generateOrderNumber();
    const [renewalPayment] = await db
      .insert(payments)
      .values({
        orderNumber: renewalOrderNumber,
        userId: originalOrder.userId,
        telegramUserId: input.telegramUserId,
        planId: originalOrder.planId,
        creditPackageId: null,
        paymentType: 'subscription_renewal',
        gateway: 'telegram_stars',
        gatewayRefId: input.telegramPaymentChargeId,
        invoicePayload: originalOrder.invoicePayload,
        invoicePayloadHmac: originalOrder.invoicePayloadHmac,
        telegramPaymentChargeId: input.telegramPaymentChargeId,
        providerPaymentChargeId: input.providerPaymentChargeId ?? null,
        amount: String(input.totalAmount),
        discountAmount: '0',
        currency: TELEGRAM_STARS_CURRENCY,
        status: 'succeeded',
        isRecurring: true,
        isFirstRecurring: false,
        subscriptionExpirationDate: expirationDate,
        idempotencyKey: `charge:${input.telegramPaymentChargeId}`,
        metadata: {
          parentOrderId: originalOrder.id,
          renewal: true,
        },
        paidAt: now,
        completedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (!renewalPayment) {
      return { ok: true, duplicate: true, paymentId: originalOrder.id };
    }
    targetPayment = renewalPayment;
  } else {
    // Non-recurring already paid -> duplicate guard
    if (originalOrder.status === 'succeeded') {
      return {
        ok: true,
        duplicate: true,
        paymentId: originalOrder.id,
        orderNumber: originalOrder.orderNumber ?? undefined,
      };
    }

    const expectedAmount = Math.round(Number(originalOrder.amount));
    if (expectedAmount !== input.totalAmount) {
      await db
        .update(payments)
        .set({ status: 'failed', updatedAt: now })
        .where(eq(payments.id, originalOrder.id));
      return { ok: false, duplicate: false, error: 'Amount mismatch on successful_payment' };
    }

    const [updated] = await db
      .update(payments)
      .set({
        status: 'succeeded',
        gatewayRefId: input.telegramPaymentChargeId,
        telegramPaymentChargeId: input.telegramPaymentChargeId,
        providerPaymentChargeId: input.providerPaymentChargeId ?? null,
        isRecurring: Boolean(input.isRecurring || originalOrder.isRecurring),
        isFirstRecurring: Boolean(input.isFirstRecurring),
        subscriptionExpirationDate: expirationDate,
        paidAt: now,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(payments.id, originalOrder.id), eq(payments.status, 'pending')))
      .returning();

    if (!updated) {
      return { ok: true, duplicate: true, paymentId: originalOrder.id };
    }
    targetPayment = updated;
  }

  await db
    .insert(paymentEvents)
    .values({
      paymentId: targetPayment.id,
      eventType: isSubsequentRenewal ? 'recurring_renewal_succeeded' : 'payment_succeeded',
      idempotencyKey: `evt:paid:${input.telegramPaymentChargeId}`,
      payload: {
        totalAmount: input.totalAmount,
        currency: input.currency,
        telegramPaymentChargeId: input.telegramPaymentChargeId,
        isRecurring: Boolean(input.isRecurring),
        isFirstRecurring: Boolean(input.isFirstRecurring),
      },
      processedAt: now,
    })
    .onConflictDoNothing();

  // Record coupon redemption if a discount coupon was used
  if (!isSubsequentRenewal && targetPayment.couponId) {
    const [redemption] = await db
      .insert(couponRedemptions)
      .values({
        couponId: targetPayment.couponId,
        userId: targetPayment.userId,
        paymentId: targetPayment.id,
        creditsAwarded: 0,
        discountApplied: targetPayment.discountAmount,
        idempotencyKey: `coupon_pay:${targetPayment.id}`,
      })
      .onConflictDoNothing()
      .returning();

    if (redemption) {
      const [cRow] = await db
        .select({ redeemedCount: coupons.redeemedCount })
        .from(coupons)
        .where(eq(coupons.id, targetPayment.couponId))
        .limit(1);
      if (cRow) {
        await db
          .update(coupons)
          .set({ redeemedCount: cRow.redeemedCount + 1, updatedAt: now })
          .where(eq(coupons.id, targetPayment.couponId));
      }
    }
  }

  // Fulfill subscription OR credit package
  let itemName = 'سفارش تلگرام استارز';
  let planTier: string | null = null;

  if (targetPayment.planId) {
    const activated = await activateOrRenewSubscription({
      userId: targetPayment.userId,
      planId: targetPayment.planId,
      endsAtOverride: expirationDate,
      autoRenew: Boolean(targetPayment.isRecurring),
      telegramChargeId: input.telegramPaymentChargeId,
      paymentId: targetPayment.id,
      grantCredits: true,
      idempotencyKey: `pay:${targetPayment.id}`,
    });
    itemName = `اشتراک ${activated.plan.name}`;
    planTier = activated.plan.tier;
  } else if (targetPayment.creditPackageId) {
    const [pkg] = await db
      .select()
      .from(creditPackages)
      .where(eq(creditPackages.id, targetPayment.creditPackageId))
      .limit(1);

    if (pkg) {
      const totalCredits = pkg.creditsAmount + pkg.bonusCredits;
      itemName = `بسته اعتبار ${pkg.name} (${totalCredits} اعتبار)`;
      await applyWalletCreditChange({
        userId: targetPayment.userId,
        amount: totalCredits,
        type: 'purchase',
        idempotencyKey: `pkg_credit:${targetPayment.id}`,
        description: `خرید بسته اعتبار ${pkg.name} با تلگرام استارز`,
        referenceType: 'credit_package',
        referenceId: pkg.id,
        relatedPaymentId: targetPayment.id,
      });
    }
  }

  // Evaluate purchase-based referral rewards
  await evaluateReferralRewardsOnPayment({
    userId: targetPayment.userId,
    paymentId: targetPayment.id,
    starsAmount: input.totalAmount,
    planTier,
  });

  // Read updated wallet balance for receipt notification
  const [wallet] = await db
    .select({ balance: creditWallets.balance })
    .from(creditWallets)
    .where(eq(creditWallets.userId, targetPayment.userId))
    .limit(1);

  const newBalance = Number(wallet?.balance ?? 0);

  await sendUserNotification({
    userId: targetPayment.userId,
    templateKey: 'payment_success',
    dedupKey: `notif:pay_ok:${targetPayment.id}`,
    variables: {
      orderNumber: targetPayment.orderNumber ?? targetPayment.id.slice(0, 8),
      starsAmount: input.totalAmount,
      itemName,
      balance: Number(newBalance.toFixed(2)),
    },
  });

  return {
    ok: true,
    duplicate: false,
    paymentId: targetPayment.id,
    orderNumber: targetPayment.orderNumber ?? undefined,
    itemName,
    newBalance,
  };
}

/**
 * Processes an official Telegram Stars refund via Bot API `refundStarPayment`,
 * updates payment ledger, optionally revokes granted credits/subscription, and writes audit log.
 */
export async function refundTelegramStarsPayment(params: {
  paymentId: string;
  reason: string;
  revokeBenefits: boolean;
  adminUserId: string;
  actorEmail: string;
  ipAddress?: string;
}): Promise<{ ok: boolean; telegramRefunded: boolean; message: string }> {
  const db = getDb();
  const now = new Date();

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, params.paymentId))
    .limit(1);

  if (!payment) {
    throw new Error('تراکنش مورد نظر یافت نشد.');
  }
  if (payment.status === 'refunded') {
    throw new Error('این تراکنش قبلاً بازپرداخت شده است.');
  }
  if (payment.status !== 'succeeded') {
    throw new Error('فقط تراکنش‌های موفق قابل بازپرداخت هستند.');
  }
  if (!payment.telegramPaymentChargeId) {
    throw new Error('شناسه پرداخت تلگرام (telegram_payment_charge_id) برای این تراکنش ثبت نشده است.');
  }

  let tgUserId = payment.telegramUserId;
  if (!tgUserId) {
    const [tgAcc] = await db
      .select({ telegramUserId: telegramAccounts.telegramUserId })
      .from(telegramAccounts)
      .where(eq(telegramAccounts.userId, payment.userId))
      .limit(1);
    tgUserId = tgAcc?.telegramUserId ?? null;
  }

  if (!tgUserId) {
    throw new Error('شناسه کاربر تلگرام برای اجرای refundStarPayment یافت نشد.');
  }

  let telegramRefunded = false;
  if (refundStarHookForTests) {
    telegramRefunded = await refundStarHookForTests({
      telegramUserId: tgUserId,
      telegramPaymentChargeId: payment.telegramPaymentChargeId,
    });
  } else {
    const tg = await getConfiguredTelegramApi();
    if (!tg) {
      throw new Error('توکن ربات تلگرام پیکربندی نشده است؛ امکان فراخوانی refundStarPayment وجود ندارد.');
    }
    await tg.api.refundStarPayment(tgUserId, payment.telegramPaymentChargeId);
    telegramRefunded = true;
  }

  if (!telegramRefunded) {
    throw new Error('بازپرداخت در سرور تلگرام تأیید نشد.');
  }

  await db
    .update(payments)
    .set({
      status: 'refunded',
      refundStatus: 'refunded',
      refundedAt: now,
      refundReason: params.reason,
      updatedAt: now,
    })
    .where(eq(payments.id, payment.id));

  await db
    .insert(paymentEvents)
    .values({
      paymentId: payment.id,
      eventType: 'stars_refunded',
      idempotencyKey: `evt:refund:${payment.id}`,
      payload: {
        reason: params.reason,
        revokeBenefits: params.revokeBenefits,
        adminUserId: params.adminUserId,
      },
      processedAt: now,
    })
    .onConflictDoNothing();

  if (params.revokeBenefits) {
    if (payment.planId) {
      await db
        .update(userSubscriptions)
        .set({
          status: 'canceled',
          autoRenew: false,
          canceledAt: now,
          canceledReason: `Refunded: ${params.reason}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(userSubscriptions.userId, payment.userId),
            eq(userSubscriptions.lastPaymentId, payment.id),
          ),
        );
    }

    if (payment.creditPackageId) {
      const [pkg] = await db
        .select()
        .from(creditPackages)
        .where(eq(creditPackages.id, payment.creditPackageId))
        .limit(1);
      if (pkg) {
        const clawback = pkg.creditsAmount + pkg.bonusCredits;
        await applyWalletCreditChange({
          userId: payment.userId,
          amount: -clawback,
          type: 'refund',
          idempotencyKey: `refund_clawback:${payment.id}`,
          description: `کسر اعتبار بابت بازپرداخت سفارش ${payment.orderNumber ?? payment.id}`,
          referenceType: 'payment_refund',
          referenceId: payment.id,
          relatedPaymentId: payment.id,
          adminUserId: params.adminUserId,
          allowNegativeOverride: true,
        });
      }
    }
  }

  await recordAuditLog({
    adminUserId: params.adminUserId,
    actorEmail: params.actorEmail,
    action: 'payment.stars_refunded',
    resourceType: 'payment',
    resourceId: payment.id,
    severity: 'warning',
    ipAddress: params.ipAddress,
    details: {
      orderNumber: payment.orderNumber,
      starsAmount: Number(payment.amount),
      reason: params.reason,
      revokeBenefits: params.revokeBenefits,
    },
  });

  return {
    ok: true,
    telegramRefunded: true,
    message: `بازپرداخت ${Number(payment.amount)} استارز با موفقیت انجام و ثبت شد.`,
  };
}
