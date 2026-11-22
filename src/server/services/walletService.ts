import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { creditTransactions, creditWallets, systemSettings } from '../../db/schema.ts';
import { sendUserNotification } from './notificationService.ts';

export type WalletTransactionType =
  | 'grant'
  | 'purchase'
  | 'subscription_credit'
  | 'promotional_credit'
  | 'usage_debit'
  | 'refund'
  | 'referral_bonus'
  | 'adjustment';

export interface ApplyCreditChangeInput {
  userId: string;
  amount: number; // positive adds credits, negative deducts credits
  type: WalletTransactionType;
  idempotencyKey: string;
  description: string;
  referenceType?: string;
  referenceId?: string;
  relatedPaymentId?: string | null;
  relatedRequestId?: string | null;
  relatedSubscriptionId?: string | null;
  adminUserId?: string | null;
  metadata?: Record<string, unknown>;
  allowNegativeOverride?: boolean;
}

export interface ApplyCreditChangeResult {
  applied: boolean;
  duplicate: boolean;
  balanceBefore: number;
  balanceAfter: number;
  transactionId: string;
}

export class WalletError extends Error {
  readonly code: 'INSUFFICIENT_BALANCE' | 'INVALID_AMOUNT';
  constructor(code: WalletError['code'], message: string) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

export async function getSystemBillingSettings(): Promise<{
  allowNegativeBalance: boolean;
  lowCreditThreshold: number;
  creditValueUsd: number;
  starValueUsd: number;
}> {
  const db = getDb();
  const rows = await db
    .select({ key: systemSettings.settingKey, value: systemSettings.value })
    .from(systemSettings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    allowNegativeBalance: map.get('allowNegativeBalance') === true,
    lowCreditThreshold: Number(map.get('lowCreditThreshold') ?? 15),
    creditValueUsd: Number(map.get('creditValueUsd') ?? 0.01),
    starValueUsd: Number(map.get('starValueUsd') ?? 0.013),
  };
}

/**
 * Atomically applies a credit addition or deduction inside a database transaction
 * with row-level locking (`SELECT ... FOR UPDATE`), full before/after ledger auditability,
 * duplicate protection via idempotencyKey, and negative-balance protection.
 */
export async function applyWalletCreditChange(
  input: ApplyCreditChangeInput,
): Promise<ApplyCreditChangeResult> {
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    throw new WalletError('INVALID_AMOUNT', 'مقدار تغییر اعتبار باید غیرصفر و معتبر باشد.');
  }

  const db = getDb();
  const billingSettings = await getSystemBillingSettings();
  const permitNegative = Boolean(input.allowNegativeOverride || billingSettings.allowNegativeBalance);

  const result = await db.transaction(async (tx) => {
    const [existingTx] = await tx
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, input.idempotencyKey))
      .limit(1);

    if (existingTx) {
      return {
        applied: false,
        duplicate: true,
        balanceBefore: Number(existingTx.balanceBefore),
        balanceAfter: Number(existingTx.balanceAfter),
        transactionId: existingTx.id,
      };
    }

    let [wallet] = await tx
      .select()
      .from(creditWallets)
      .where(eq(creditWallets.userId, input.userId))
      .for('update');

    if (!wallet) {
      const [created] = await tx
        .insert(creditWallets)
        .values({
          userId: input.userId,
          balance: '0',
          reservedBalance: '0',
          lifetimeEarned: '0',
          lifetimeSpent: '0',
        })
        .returning();
      wallet = created;
    }

    if (!wallet) {
      throw new Error('Failed to access or initialize user credit wallet');
    }

    const balanceBefore = Number(wallet.balance);
    const reserved = Number(wallet.reservedBalance);
    const balanceAfter = Number((balanceBefore + input.amount).toFixed(4));

    if (input.amount < 0 && !permitNegative && balanceAfter - reserved < 0) {
      throw new WalletError(
        'INSUFFICIENT_BALANCE',
        `موجودی قابل برداشت کافی نیست. موجودی آزاد: ${Math.max(0, balanceBefore - reserved).toFixed(2)}`,
      );
    }

    const nextEarned =
      input.amount > 0 ? Number(wallet.lifetimeEarned) + input.amount : Number(wallet.lifetimeEarned);
    const nextSpent =
      input.amount < 0 ? Number(wallet.lifetimeSpent) + Math.abs(input.amount) : Number(wallet.lifetimeSpent);

    await tx
      .update(creditWallets)
      .set({
        balance: balanceAfter.toFixed(4),
        lifetimeEarned: nextEarned.toFixed(4),
        lifetimeSpent: nextSpent.toFixed(4),
        updatedAt: new Date(),
      })
      .where(eq(creditWallets.id, wallet.id));

    const [txRow] = await tx
      .insert(creditTransactions)
      .values({
        walletId: wallet.id,
        userId: input.userId,
        type: input.type,
        amount: input.amount.toFixed(4),
        balanceBefore: balanceBefore.toFixed(4),
        balanceAfter: balanceAfter.toFixed(4),
        idempotencyKey: input.idempotencyKey,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        relatedPaymentId: input.relatedPaymentId ?? null,
        relatedRequestId: input.relatedRequestId ?? null,
        relatedSubscriptionId: input.relatedSubscriptionId ?? null,
        adminUserId: input.adminUserId ?? null,
        description: input.description,
        metadata: input.metadata ?? {},
      })
      .returning({ id: creditTransactions.id });

    return {
      applied: true,
      duplicate: false,
      balanceBefore,
      balanceAfter,
      transactionId: txRow!.id,
    };
  });

  if (result.applied && input.amount < 0) {
    await checkAndNotifyLowCredits(input.userId, result.balanceAfter, billingSettings.lowCreditThreshold);
  }

  return result;
}

export async function checkAndNotifyLowCredits(
  userId: string,
  balance: number,
  thresholdOverride?: number,
): Promise<void> {
  const threshold =
    thresholdOverride ?? (await getSystemBillingSettings()).lowCreditThreshold;
  if (threshold <= 0 || balance > threshold) return;
  const today = new Date().toISOString().slice(0, 10);
  await sendUserNotification({
    userId,
    templateKey: 'low_credits',
    dedupKey: `low_credits:${userId}:${today}`,
    variables: {
      balance: Number(balance.toFixed(2)),
    },
  }).catch(() => {});
}
