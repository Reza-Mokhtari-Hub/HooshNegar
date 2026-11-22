import { Router, type Response } from 'express';
import { and, count, desc, eq, gte, lte, ne, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiRequests,
  creditPackages,
  creditTransactions,
  payments,
  subscriptionPlans,
  telegramAccounts,
  userProfiles,
  users,
  userSubscriptions,
} from '../../db/schema.ts';
import { refundPaymentSchema } from '../../shared/validation.ts';
import {
  getClientIp,
  requireAdminAuth,
  requireRole,
  type AdminRequest,
} from '../middleware/auth.ts';
import { getSystemBillingSettings } from '../services/walletService.ts';
import { refundTelegramStarsPayment } from '../services/telegramStarsService.ts';

function sanitizeCsvCell(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val);
  // Mitigate CSV formula injection (=, +, -, @, tab, CR)
  const neutralized = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

function buildPaymentFilters(query: Record<string, unknown>): SQL[] {
  const conds: SQL[] = [];
  if (typeof query.from === 'string' && query.from.trim()) {
    const d = new Date(query.from);
    if (!Number.isNaN(d.getTime())) conds.push(gte(payments.createdAt, d));
  }
  if (typeof query.to === 'string' && query.to.trim()) {
    const d = new Date(query.to);
    if (!Number.isNaN(d.getTime())) conds.push(lte(payments.createdAt, d));
  }
  if (typeof query.planId === 'string' && query.planId.trim()) {
    conds.push(eq(payments.planId, query.planId.trim()));
  }
  if (typeof query.userId === 'string' && query.userId.trim()) {
    conds.push(eq(payments.userId, query.userId.trim()));
  }
  if (
    typeof query.status === 'string' &&
    ['pending', 'processing', 'succeeded', 'failed', 'refunded', 'canceled'].includes(query.status)
  ) {
    conds.push(eq(payments.status, query.status as typeof payments.$inferSelect.status));
  }
  return conds;
}

export function createFinanceRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);

  router.get('/finance/summary', async (req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const q = req.query as Record<string, unknown>;
      const paymentConds = buildPaymentFilters(q);
      const paymentWhere = paymentConds.length > 0 ? and(...paymentConds) : undefined;

      const reqConds: SQL[] = [eq(aiRequests.status, 'succeeded')];
      if (typeof q.from === 'string' && q.from.trim()) {
        const d = new Date(q.from);
        if (!Number.isNaN(d.getTime())) reqConds.push(gte(aiRequests.createdAt, d));
      }
      if (typeof q.to === 'string' && q.to.trim()) {
        const d = new Date(q.to);
        if (!Number.isNaN(d.getTime())) reqConds.push(lte(aiRequests.createdAt, d));
      }
      if (typeof q.providerId === 'string' && q.providerId.trim()) {
        reqConds.push(eq(aiRequests.providerId, q.providerId.trim()));
      }
      if (typeof q.modelId === 'string' && q.modelId.trim()) {
        reqConds.push(eq(aiRequests.modelId, q.modelId.trim()));
      }
      if (typeof q.userId === 'string' && q.userId.trim()) {
        reqConds.push(eq(aiRequests.userId, q.userId.trim()));
      }

      const [
        billingSettings,
        filteredPayments,
        [totalUsersRow],
        [activePaidSubsRow],
        [expiredSubsRow],
        [creditSummary],
        [aiCostSummary],
        recentLedger,
      ] = await Promise.all([
        getSystemBillingSettings(),
        db
          .select({
            id: payments.id,
            orderNumber: payments.orderNumber,
            userId: payments.userId,
            userDisplayName: userProfiles.displayName,
            telegramUsername: telegramAccounts.username,
            planId: payments.planId,
            planName: subscriptionPlans.name,
            creditPackageId: payments.creditPackageId,
            packageName: creditPackages.name,
            paymentType: payments.paymentType,
            gateway: payments.gateway,
            telegramPaymentChargeId: payments.telegramPaymentChargeId,
            amount: payments.amount,
            discountAmount: payments.discountAmount,
            currency: payments.currency,
            status: payments.status,
            isRecurring: payments.isRecurring,
            refundStatus: payments.refundStatus,
            refundReason: payments.refundReason,
            paidAt: payments.paidAt,
            createdAt: payments.createdAt,
          })
          .from(payments)
          .leftJoin(userProfiles, eq(userProfiles.userId, payments.userId))
          .leftJoin(telegramAccounts, eq(telegramAccounts.userId, payments.userId))
          .leftJoin(subscriptionPlans, eq(payments.planId, subscriptionPlans.id))
          .leftJoin(creditPackages, eq(payments.creditPackageId, creditPackages.id))
          .where(paymentWhere)
          .orderBy(desc(payments.createdAt))
          .limit(200),
        db.select({ total: count() }).from(users),
        db
          .select({ total: count() })
          .from(userSubscriptions)
          .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
          .where(
            and(
              eq(userSubscriptions.status, 'active'),
              ne(subscriptionPlans.tier, 'free'),
            ),
          ),
        db
          .select({ total: count() })
          .from(userSubscriptions)
          .where(eq(userSubscriptions.status, 'expired')),
        db
          .select({
            purchasedCredits: sql<string>`coalesce(sum(case when ${creditTransactions.type} = 'purchase' then ${creditTransactions.amount} else 0 end), 0)`,
            subscriptionCredits: sql<string>`coalesce(sum(case when ${creditTransactions.type} = 'subscription_credit' then ${creditTransactions.amount} else 0 end), 0)`,
            promotionalCredits: sql<string>`coalesce(sum(case when ${creditTransactions.type} in ('promotional_credit', 'referral_bonus', 'grant') then ${creditTransactions.amount} else 0 end), 0)`,
            usageDebits: sql<string>`coalesce(sum(case when ${creditTransactions.type} = 'usage_debit' then abs(${creditTransactions.amount}) else 0 end), 0)`,
          })
          .from(creditTransactions),
        db
          .select({
            totalCostUsd: sql<string>`coalesce(sum(${aiRequests.costUsd}), 0)`,
            totalRequests: count(),
          })
          .from(aiRequests)
          .where(and(...reqConds)),
        db
          .select({
            id: creditTransactions.id,
            userId: creditTransactions.userId,
            userDisplayName: userProfiles.displayName,
            type: creditTransactions.type,
            amount: creditTransactions.amount,
            balanceBefore: creditTransactions.balanceBefore,
            balanceAfter: creditTransactions.balanceAfter,
            description: creditTransactions.description,
            createdAt: creditTransactions.createdAt,
          })
          .from(creditTransactions)
          .leftJoin(userProfiles, eq(userProfiles.userId, creditTransactions.userId))
          .orderBy(desc(creditTransactions.createdAt))
          .limit(100),
      ]);

      let totalSuccessfulPayments = 0;
      let totalStarsXtr = 0;
      let subscriptionStarsXtr = 0;
      let creditPackageStarsXtr = 0;
      let renewalsCount = 0;
      let failedPayments = 0;
      let refundedPayments = 0;
      let refundedStarsXtr = 0;

      for (const p of filteredPayments) {
        const amt = Number(p.amount);
        if (p.status === 'succeeded') {
          totalSuccessfulPayments += 1;
          totalStarsXtr += amt;
          if (p.paymentType === 'credit_package') {
            creditPackageStarsXtr += amt;
          } else {
            subscriptionStarsXtr += amt;
          }
          if (p.paymentType === 'subscription_renewal') {
            renewalsCount += 1;
          }
        } else if (p.status === 'failed') {
          failedPayments += 1;
        } else if (p.status === 'refunded') {
          refundedPayments += 1;
          refundedStarsXtr += amt;
        }
      }

      const totalUsers = totalUsersRow?.total ?? 0;
      const activePaidSubscriptions = activePaidSubsRow?.total ?? 0;
      const freeUsers = Math.max(0, totalUsers - activePaidSubscriptions);
      const conversionRatePct =
        totalUsers > 0 ? Number(((activePaidSubscriptions / totalUsers) * 100).toFixed(2)) : 0;

      const estimatedRevenueUsd = Number((totalStarsXtr * billingSettings.starValueUsd).toFixed(4));
      const estimatedProviderCostUsd = Number(Number(aiCostSummary?.totalCostUsd ?? 0).toFixed(6));
      const estimatedGrossProfitUsd = Number(
        (estimatedRevenueUsd - estimatedProviderCostUsd).toFixed(4),
      );
      const estimatedMarginPct =
        estimatedRevenueUsd > 0
          ? Number(((estimatedGrossProfitUsd / estimatedRevenueUsd) * 100).toFixed(2))
          : 0;

      res.json({
        kpis: {
          totalSuccessfulPayments,
          totalStarsXtr,
          subscriptionStarsXtr,
          creditPackageStarsXtr,
          estimatedRevenueUsd,
          starValueUsd: billingSettings.starValueUsd,
          activePaidSubscriptions,
          freeUsers,
          conversionRatePct,
          renewalsCount,
          expiredSubscriptions: expiredSubsRow?.total ?? 0,
          failedPayments,
          refundedPayments,
          refundedStarsXtr,
          purchasedCredits: Number(creditSummary?.purchasedCredits ?? 0),
          subscriptionCredits: Number(creditSummary?.subscriptionCredits ?? 0),
          promotionalCredits: Number(creditSummary?.promotionalCredits ?? 0),
          usageDebits: Number(creditSummary?.usageDebits ?? 0),
          estimatedProviderCostUsd,
          estimatedGrossProfitUsd,
          estimatedMarginPct,
          totalSuccessfulAiRequests: aiCostSummary?.totalRequests ?? 0,
          isEstimatedCost: true,
        },
        payments: filteredPayments.map((p) => ({
          ...p,
          amount: Number(p.amount),
          discountAmount: Number(p.discountAmount),
        })),
        creditLedger: recentLedger.map((l) => ({
          ...l,
          amount: Number(l.amount),
          balanceBefore: Number(l.balanceBefore),
          balanceAfter: Number(l.balanceAfter),
        })),
      });
    } catch (err) {
      console.error('[finance/summary]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در محاسبه گزارش مالی.' });
    }
  });

  router.get('/finance/export.csv', async (req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const conds = buildPaymentFilters(req.query as Record<string, unknown>);
      const rows = await db
        .select({
          orderNumber: payments.orderNumber,
          userId: payments.userId,
          userDisplayName: userProfiles.displayName,
          paymentType: payments.paymentType,
          planName: subscriptionPlans.name,
          packageName: creditPackages.name,
          amount: payments.amount,
          discountAmount: payments.discountAmount,
          currency: payments.currency,
          status: payments.status,
          refundStatus: payments.refundStatus,
          telegramPaymentChargeId: payments.telegramPaymentChargeId,
          createdAt: payments.createdAt,
        })
        .from(payments)
        .leftJoin(userProfiles, eq(userProfiles.userId, payments.userId))
        .leftJoin(subscriptionPlans, eq(payments.planId, subscriptionPlans.id))
        .leftJoin(creditPackages, eq(payments.creditPackageId, creditPackages.id))
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(payments.createdAt))
        .limit(2000);

      const header = [
        'order_number',
        'user_id',
        'user_name',
        'payment_type',
        'item',
        'amount',
        'discount',
        'currency',
        'status',
        'refund_status',
        'telegram_charge_id',
        'created_at',
      ].join(',');

      const lines = rows.map((r) =>
        [
          r.orderNumber ?? '',
          r.userId,
          r.userDisplayName ?? '',
          r.paymentType,
          r.planName ?? r.packageName ?? '',
          r.amount,
          r.discountAmount,
          r.currency,
          r.status,
          r.refundStatus,
          r.telegramPaymentChargeId ?? '',
          r.createdAt.toISOString(),
        ]
          .map(sanitizeCsvCell)
          .join(','),
      );

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="hooshnegar-finance-export.csv"');
      res.send(`\uFEFF${[header, ...lines].join('\n')}`);
    } catch {
      res.status(500).json({ error: 'خطا در خروجی CSV مالی.' });
    }
  });

  router.post(
    '/finance/payments/:id/refund',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      const paymentId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      try {
        const parsed = refundPaymentSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'دلیل بازپرداخت الزامی است.' });
          return;
        }
        const result = await refundTelegramStarsPayment({
          paymentId,
          reason: parsed.data.reason,
          revokeBenefits: parsed.data.revokeBenefits,
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          ipAddress: ip,
        });
        res.json(result);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'خطا در بازپرداخت استارز.' });
      }
    },
  );

  return router;
}
