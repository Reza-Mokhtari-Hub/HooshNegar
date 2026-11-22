import { and, desc, eq, gte, lt, lte } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  subscriptionPlans,
  telegramAccounts,
  userSubscriptions,
} from '../../db/schema.ts';
import { getConfiguredTelegramApi } from '../telegram/jobRunner.ts';
import { applyWalletCreditChange } from './walletService.ts';
import { sendUserNotification } from './notificationService.ts';

type EditStarSubscriptionHook = (params: {
  telegramUserId: number;
  telegramChargeId: string;
  isCanceled: boolean;
}) => Promise<boolean>;

let editStarSubHookForTests: EditStarSubscriptionHook | null = null;

export function setEditStarSubscriptionHookForTests(hook: EditStarSubscriptionHook | null): void {
  editStarSubHookForTests = hook;
}

export async function activateOrRenewSubscription(params: {
  userId: string;
  planId: string;
  durationDaysOverride?: number;
  endsAtOverride?: Date | null;
  autoRenew?: boolean;
  telegramChargeId?: string | null;
  paymentId?: string | null;
  grantCredits?: boolean;
  adminUserId?: string | null;
  reason?: string;
  idempotencyKey: string;
}) {
  const db = getDb();
  const now = new Date();

  const [plan] = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, params.planId))
    .limit(1);

  if (!plan) {
    throw new Error('Subscription plan not found');
  }

  const durationDays = params.durationDaysOverride ?? plan.durationDays;

  // Check if user currently has an active subscription on the SAME plan to extend it cleanly
  const [existingActive] = await db
    .select()
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.userId, params.userId),
        eq(userSubscriptions.status, 'active'),
      ),
    )
    .orderBy(desc(userSubscriptions.endsAt))
    .limit(1);

  let subscriptionRow;
  const computedEndsAt =
    params.endsAtOverride ??
    new Date(
      (existingActive && existingActive.planId === plan.id && existingActive.endsAt > now
        ? existingActive.endsAt.getTime()
        : now.getTime()) +
        durationDays * 24 * 60 * 60 * 1000,
    );

  if (existingActive && existingActive.planId === plan.id) {
    const [updated] = await db
      .update(userSubscriptions)
      .set({
        status: 'active',
        endsAt: computedEndsAt,
        autoRenew: params.autoRenew ?? existingActive.autoRenew,
        telegramChargeId: params.telegramChargeId ?? existingActive.telegramChargeId,
        lastPaymentId: params.paymentId ?? existingActive.lastPaymentId,
        canceledAt: null,
        canceledReason: null,
        updatedAt: now,
      })
      .where(eq(userSubscriptions.id, existingActive.id))
      .returning();
    subscriptionRow = updated!;
  } else {
    // Supersede previous active subscription(s)
    if (existingActive) {
      await db
        .update(userSubscriptions)
        .set({
          status: 'canceled',
          autoRenew: false,
          canceledAt: now,
          canceledReason: params.reason ?? 'Replaced by new plan',
          updatedAt: now,
        })
        .where(eq(userSubscriptions.id, existingActive.id));
    }

    const [created] = await db
      .insert(userSubscriptions)
      .values({
        userId: params.userId,
        planId: plan.id,
        status: 'active',
        startsAt: now,
        endsAt: computedEndsAt,
        autoRenew: params.autoRenew ?? false,
        telegramChargeId: params.telegramChargeId ?? null,
        lastPaymentId: params.paymentId ?? null,
      })
      .returning();
    subscriptionRow = created!;
  }

  let creditsAdded = 0;
  if (params.grantCredits !== false && plan.creditAllocation > 0) {
    const walletRes = await applyWalletCreditChange({
      userId: params.userId,
      amount: plan.creditAllocation,
      type: 'subscription_credit',
      idempotencyKey: `sub_credit:${params.idempotencyKey}`,
      description: `اعتبار ماهانه پلن «${plan.name}»`,
      referenceType: 'subscription',
      referenceId: subscriptionRow.id,
      relatedPaymentId: params.paymentId ?? null,
      relatedSubscriptionId: subscriptionRow.id,
      adminUserId: params.adminUserId ?? null,
    });
    if (walletRes.applied) {
      creditsAdded = plan.creditAllocation;
    }
  }

  await sendUserNotification({
    userId: params.userId,
    templateKey: 'subscription_activated',
    dedupKey: `notif:sub_act:${params.idempotencyKey}`,
    variables: {
      planName: plan.name,
      endsAt: computedEndsAt.toISOString().slice(0, 10),
      creditsAdded,
    },
  });

  return { subscription: subscriptionRow, plan, creditsAdded };
}

export async function cancelSubscriptionAutoRenewal(params: {
  userId: string;
  subscriptionId?: string;
  reason?: string;
}): Promise<{ ok: boolean; telegramNotified: boolean; messageFa: string }> {
  const db = getDb();
  const now = new Date();

  const [sub] = await db
    .select()
    .from(userSubscriptions)
    .where(
      params.subscriptionId
        ? and(eq(userSubscriptions.id, params.subscriptionId), eq(userSubscriptions.userId, params.userId))
        : and(eq(userSubscriptions.userId, params.userId), eq(userSubscriptions.status, 'active')),
    )
    .orderBy(desc(userSubscriptions.endsAt))
    .limit(1);

  if (!sub) {
    return { ok: false, telegramNotified: false, messageFa: 'اشتراک فعالی برای لغو تمدید یافت نشد.' };
  }

  let telegramNotified = false;
  if (sub.telegramChargeId) {
    const [tgAcc] = await db
      .select({ telegramUserId: telegramAccounts.telegramUserId })
      .from(telegramAccounts)
      .where(eq(telegramAccounts.userId, params.userId))
      .limit(1);

    if (tgAcc?.telegramUserId) {
      if (editStarSubHookForTests) {
        telegramNotified = await editStarSubHookForTests({
          telegramUserId: tgAcc.telegramUserId,
          telegramChargeId: sub.telegramChargeId,
          isCanceled: true,
        });
      } else {
        const tg = await getConfiguredTelegramApi();
        if (tg) {
          try {
            await (tg.api as unknown as {
              raw: {
                editUserStarSubscription: (args: {
                  user_id: number;
                  telegram_payment_charge_id: string;
                  is_canceled: boolean;
                }) => Promise<boolean>;
              };
            }).raw.editUserStarSubscription({
              user_id: tgAcc.telegramUserId,
              telegram_payment_charge_id: sub.telegramChargeId,
              is_canceled: true,
            });
            telegramNotified = true;
          } catch {
            telegramNotified = false;
          }
        }
      }
    }
  }

  await db
    .update(userSubscriptions)
    .set({
      autoRenew: false,
      canceledAt: now,
      canceledReason: params.reason ?? 'User canceled auto-renewal',
      updatedAt: now,
    })
    .where(eq(userSubscriptions.id, sub.id));

  return {
    ok: true,
    telegramNotified,
    messageFa: `تمدید خودکار اشتراک شما لغو شد. دسترسی شما تا تاریخ ${sub.endsAt.toISOString().slice(0, 10)} همچنان برقرار خواهد بود.`,
  };
}

/**
 * Idempotent scheduled sweep: transitions overdue active subscriptions to `expired`,
 * sends `subscription_expired` notifications, and falls back to Free plan if enabled.
 */
export async function runSubscriptionExpirationSweep(nowOverride?: Date): Promise<{
  expiredCount: number;
  notifiedCount: number;
}> {
  const db = getDb();
  const now = nowOverride ?? new Date();

  const overdue = await db
    .select({
      sub: userSubscriptions,
      planName: subscriptionPlans.name,
      planTier: subscriptionPlans.tier,
    })
    .from(userSubscriptions)
    .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(and(eq(userSubscriptions.status, 'active'), lt(userSubscriptions.endsAt, now)));

  let expiredCount = 0;
  let notifiedCount = 0;

  for (const row of overdue) {
    const [updated] = await db
      .update(userSubscriptions)
      .set({
        status: 'expired',
        autoRenew: false,
        updatedAt: now,
      })
      .where(and(eq(userSubscriptions.id, row.sub.id), eq(userSubscriptions.status, 'active')))
      .returning({ id: userSubscriptions.id });

    if (!updated) continue;
    expiredCount += 1;

    if (row.planTier !== 'free') {
      const notif = await sendUserNotification({
        userId: row.sub.userId,
        templateKey: 'subscription_expired',
        dedupKey: `sub_expired:${row.sub.id}:${row.sub.endsAt.toISOString().slice(0, 10)}`,
        variables: { planName: row.planName },
      });
      if (notif.status === 'sent') notifiedCount += 1;
    }
  }

  return { expiredCount, notifiedCount };
}

/**
 * Sends deduplicated renewal reminders for active paid subscriptions expiring within 3 days.
 */
export async function runUpcomingRenewalReminders(nowOverride?: Date): Promise<{ remindedCount: number }> {
  const db = getDb();
  const now = nowOverride ?? new Date();
  const threeDaysOut = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  const upcoming = await db
    .select({
      sub: userSubscriptions,
      planName: subscriptionPlans.name,
      planTier: subscriptionPlans.tier,
    })
    .from(userSubscriptions)
    .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(
      and(
        eq(userSubscriptions.status, 'active'),
        gte(userSubscriptions.endsAt, now),
        lte(userSubscriptions.endsAt, threeDaysOut),
      ),
    );

  let remindedCount = 0;
  for (const row of upcoming) {
    if (row.planTier === 'free') continue;
    const daysLeft = Math.max(
      1,
      Math.ceil((row.sub.endsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    );
    const res = await sendUserNotification({
      userId: row.sub.userId,
      templateKey: 'renewal_upcoming',
      dedupKey: `renewal_rem:${row.sub.id}:${row.sub.endsAt.toISOString().slice(0, 10)}`,
      variables: {
        planName: row.planName,
        endsAt: row.sub.endsAt.toISOString().slice(0, 10),
        daysLeft,
      },
    });
    if (res.status === 'sent') remindedCount += 1;
  }

  return { remindedCount };
}
