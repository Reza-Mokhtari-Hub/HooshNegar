import { Router, type Response } from 'express';
import { count, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  aiModels,
  aiRequests,
  coupons,
  creditPackages,
  creditTransactions,
  creditWallets,
  payments,
  referralCodes,
  referralProgramSettings,
  referralRelationships,
  referralRewards,
  subscriptionPlans,
  supportTickets,
  telegramAccounts,
  userLimitOverrides,
  userProfiles,
  users,
  userSubscriptions,
} from '../../db/schema.ts';
import {
  creditAdjustmentSchema,
  creditPackageSchema,
  manualPlanAssignSchema,
  referralProgramSettingsSchema,
  userLimitOverrideSchema,
} from '../../shared/validation.ts';
import { recordAuditLog } from '../security/audit.ts';
import {
  getClientIp,
  requireAdminAuth,
  requireRole,
  type AdminRequest,
} from '../middleware/auth.ts';
import { applyWalletCreditChange, WalletError } from '../services/walletService.ts';
import { activateOrRenewSubscription } from '../services/subscriptionService.ts';
import { getReferralProgramConfig } from '../services/referralCouponService.ts';
import { sendUserNotification } from '../services/notificationService.ts';

export function createBillingRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);

  // =========================================================================
  // 1. CREDIT PACKAGES CRUD (Telegram Stars XTR)
  // =========================================================================
  router.get('/credit-packages', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(creditPackages)
        .orderBy(creditPackages.sortOrder, desc(creditPackages.createdAt));
      res.json({ packages: rows });
    } catch (err) {
      console.error('[credit-packages/list]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت بسته‌های اعتبار.' });
    }
  });

  router.post('/credit-packages', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = creditPackageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'اطلاعات بسته اعتبار نامعتبر است.' });
        return;
      }
      const db = getDb();
      const [created] = await db.insert(creditPackages).values(parsed.data).returning();
      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'credit_package.created',
        resourceType: 'credit_package',
        resourceId: created?.id,
        ipAddress: ip,
        userAgent: ua,
        details: { name: created?.name, starsPrice: created?.starsPrice, creditsAmount: created?.creditsAmount },
      });
      res.status(201).json({ package: created });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('unique') || msg.includes('duplicate')) {
        res.status(409).json({ error: 'بسته‌ای با این اسلاگ قبلاً ثبت شده است.' });
        return;
      }
      res.status(500).json({ error: 'خطا در ایجاد بسته اعتبار.' });
    }
  });

  router.patch('/credit-packages/:id', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = creditPackageSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'اطلاعات نامعتبر است.' });
        return;
      }
      const db = getDb();
      const [updated] = await db
        .update(creditPackages)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(creditPackages.id, id))
        .returning();
      if (!updated) {
        res.status(404).json({ error: 'بسته اعتبار یافت نشد.' });
        return;
      }
      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'credit_package.updated',
        resourceType: 'credit_package',
        resourceId: updated.id,
        ipAddress: ip,
        userAgent: ua,
        details: { name: updated.name, isActive: updated.isActive, starsPrice: updated.starsPrice },
      });
      res.json({ package: updated });
    } catch {
      res.status(500).json({ error: 'خطا در به‌روزرسانی بسته اعتبار.' });
    }
  });

  router.delete('/credit-packages/:id', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const db = getDb();
      const [deleted] = await db
        .delete(creditPackages)
        .where(eq(creditPackages.id, id))
        .returning({ id: creditPackages.id, name: creditPackages.name });
      if (!deleted) {
        res.status(404).json({ error: 'بسته اعتبار یافت نشد.' });
        return;
      }
      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'credit_package.deleted',
        resourceType: 'credit_package',
        resourceId: deleted.id,
        severity: 'warning',
        ipAddress: ip,
        userAgent: ua,
        details: { name: deleted.name },
      });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'خطا در حذف بسته اعتبار.' });
    }
  });

  // =========================================================================
  // 2. REFERRAL PROGRAM SETTINGS & ANALYTICS + COUPON MANAGEMENT
  // =========================================================================
  router.get('/referrals/settings', async (_req: AdminRequest, res: Response) => {
    try {
      const settings = await getReferralProgramConfig();
      res.json({ settings });
    } catch {
      res.status(500).json({ error: 'خطا در دریافت تنظیمات برنامه معرفی.' });
    }
  });

  router.put('/referrals/settings', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = referralProgramSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'تنظیمات معرفی نامعتبر است.' });
        return;
      }
      const d = parsed.data;
      const db = getDb();
      const now = new Date();
      const values = {
        singletonKey: 'primary',
        isActive: d.isActive,
        inviterRewardType: d.inviterRewardType,
        inviterBonusCredits: d.inviterBonusCredits,
        inviterFreeDays: d.inviterFreeDays,
        invitedBonusCredits: d.invitedBonusCredits,
        requirePurchase: d.requirePurchase,
        minPurchaseStars: d.minPurchaseStars,
        minPlanTier: d.minPlanTier,
        maxReferralsPerAccount: d.maxReferralsPerAccount,
        maxRewardCreditsPerAccount: d.maxRewardCreditsPerAccount,
        fraudVelocityLimitPerHour: d.fraudVelocityLimitPerHour,
        campaignStartsAt: d.campaignStartsAt ? new Date(d.campaignStartsAt) : null,
        campaignEndsAt: d.campaignEndsAt ? new Date(d.campaignEndsAt) : null,
        updatedAt: now,
      };

      const [saved] = await db
        .insert(referralProgramSettings)
        .values(values)
        .onConflictDoUpdate({
          target: referralProgramSettings.singletonKey,
          set: values,
        })
        .returning();

      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'referral.settings_updated',
        resourceType: 'referral_program_settings',
        resourceId: saved?.id,
        ipAddress: ip,
        userAgent: ua,
        details: {
          isActive: d.isActive,
          requirePurchase: d.requirePurchase,
          inviterRewardType: d.inviterRewardType,
          inviterBonusCredits: d.inviterBonusCredits,
        },
      });

      res.json({ settings: saved });
    } catch {
      res.status(500).json({ error: 'خطا در ذخیره تنظیمات برنامه معرفی.' });
    }
  });

  router.get('/referrals/analytics', async (_req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [
        [totalRels],
        [qualifiedRels],
        [flaggedRels],
        [rewardStats],
        [revenueFromReferred],
        topReferrers,
      ] = await Promise.all([
        db.select({ total: count() }).from(referralRelationships),
        db
          .select({ total: count() })
          .from(referralRelationships)
          .where(eq(referralRelationships.status, 'rewarded')),
        db
          .select({ total: count() })
          .from(referralRelationships)
          .where(eq(referralRelationships.status, 'flagged')),
        db
          .select({
            creditsIssued: sql<string>`coalesce(sum(${referralRewards.creditsAwarded}), 0)`,
            daysIssued: sql<string>`coalesce(sum(${referralRewards.subscriptionDaysAwarded}), 0)`,
          })
          .from(referralRewards)
          .where(eq(referralRewards.status, 'awarded')),
        db
          .select({
            starsTotal: sql<string>`coalesce(sum(${payments.amount}), 0)`,
            paidCount: count(),
          })
          .from(payments)
          .innerJoin(
            referralRelationships,
            eq(referralRelationships.referredUserId, payments.userId),
          )
          .where(eq(payments.status, 'succeeded')),
        db
          .select({
            referrerUserId: referralRelationships.referrerUserId,
            displayName: userProfiles.displayName,
            telegramUsername: telegramAccounts.username,
            totalInvited: count(),
          })
          .from(referralRelationships)
          .leftJoin(userProfiles, eq(userProfiles.userId, referralRelationships.referrerUserId))
          .leftJoin(telegramAccounts, eq(telegramAccounts.userId, referralRelationships.referrerUserId))
          .groupBy(
            referralRelationships.referrerUserId,
            userProfiles.displayName,
            telegramAccounts.username,
          )
          .orderBy(desc(count()))
          .limit(10),
      ]);

      const total = totalRels?.total ?? 0;
      const qualified = qualifiedRels?.total ?? 0;
      res.json({
        analytics: {
          totalInvited: total,
          qualifiedCount: qualified,
          pendingCount: Math.max(0, total - qualified - (flaggedRels?.total ?? 0)),
          flaggedCount: flaggedRels?.total ?? 0,
          conversionRatePct: total > 0 ? Number(((qualified / total) * 100).toFixed(2)) : 0,
          totalCreditsAwarded: Number(rewardStats?.creditsIssued ?? 0),
          totalSubscriptionDaysAwarded: Number(rewardStats?.daysIssued ?? 0),
          referredUsersStarsRevenue: Number(revenueFromReferred?.starsTotal ?? 0),
          referredUsersPaidOrders: revenueFromReferred?.paidCount ?? 0,
          topReferrers,
        },
      });
    } catch (err) {
      console.error('[referrals/analytics]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در محاسبه آمار برنامه معرفی.' });
    }
  });

  router.patch('/coupons/:id', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const isActive = typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined;
      if (isActive === undefined) {
        res.status(400).json({ error: 'وضعیت فعال/غیرفعال کد الزامی است.' });
        return;
      }
      const db = getDb();
      const [updated] = await db
        .update(coupons)
        .set({ isActive, updatedAt: new Date() })
        .where(eq(coupons.id, id))
        .returning();
      if (!updated) {
        res.status(404).json({ error: 'کد تخفیف یافت نشد.' });
        return;
      }
      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'coupon.toggled',
        resourceType: 'coupon',
        resourceId: updated.id,
        ipAddress: ip,
        userAgent: ua,
        details: { code: updated.code, isActive: updated.isActive },
      });
      res.json({ coupon: { ...updated, discountValue: Number(updated.discountValue) } });
    } catch {
      res.status(500).json({ error: 'خطا در به‌روزرسانی کد تخفیف.' });
    }
  });

  router.delete('/coupons/:id', requireRole('admin'), async (req: AdminRequest, res: Response) => {
    const id = String(req.params.id ?? '');
    try {
      const db = getDb();
      const [deleted] = await db
        .delete(coupons)
        .where(eq(coupons.id, id))
        .returning({ id: coupons.id, code: coupons.code });
      if (!deleted) {
        res.status(404).json({ error: 'کد تخفیف یافت نشد.' });
        return;
      }
      await recordAuditLog({
        adminUserId: req.admin!.id,
        actorEmail: req.admin!.email,
        action: 'coupon.deleted',
        resourceType: 'coupon',
        resourceId: deleted.id,
        severity: 'warning',
        details: { code: deleted.code },
      });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'خطا در حذف کد تخفیف.' });
    }
  });

  // =========================================================================
  // 3. COMPLETE ADMIN USER MANAGEMENT (Detail, Credits, Plans, Limits, Promo, Delete)
  // =========================================================================
  router.get('/users/:id/detail', async (req: AdminRequest, res: Response) => {
    const userId = String(req.params.id ?? '');
    try {
      const db = getDb();
      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) {
        res.status(404).json({ error: 'کاربر یافت نشد.' });
        return;
      }

      const [
        [profile],
        [telegramAccount],
        [wallet],
        [limitOverride],
        subscriptionsList,
        ledger,
        recentRequests,
        userPayments,
        referralsSent,
        [refCode],
        tickets,
      ] = await Promise.all([
        db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1),
        db.select().from(telegramAccounts).where(eq(telegramAccounts.userId, userId)).limit(1),
        db.select().from(creditWallets).where(eq(creditWallets.userId, userId)).limit(1),
        db.select().from(userLimitOverrides).where(eq(userLimitOverrides.userId, userId)).limit(1),
        db
          .select({
            id: userSubscriptions.id,
            planId: userSubscriptions.planId,
            planName: subscriptionPlans.name,
            planTier: subscriptionPlans.tier,
            status: userSubscriptions.status,
            startsAt: userSubscriptions.startsAt,
            endsAt: userSubscriptions.endsAt,
            autoRenew: userSubscriptions.autoRenew,
            createdAt: userSubscriptions.createdAt,
          })
          .from(userSubscriptions)
          .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
          .where(eq(userSubscriptions.userId, userId))
          .orderBy(desc(userSubscriptions.createdAt))
          .limit(10),
        db
          .select()
          .from(creditTransactions)
          .where(eq(creditTransactions.userId, userId))
          .orderBy(desc(creditTransactions.createdAt))
          .limit(30),
        db
          .select({
            id: aiRequests.id,
            capability: aiRequests.capability,
            status: aiRequests.status,
            modelName: aiModels.name,
            creditsCharged: aiRequests.creditsCharged,
            costUsd: aiRequests.costUsd,
            latencyMs: aiRequests.latencyMs,
            createdAt: aiRequests.createdAt,
          })
          .from(aiRequests)
          .leftJoin(aiModels, eq(aiRequests.modelId, aiModels.id))
          .where(eq(aiRequests.userId, userId))
          .orderBy(desc(aiRequests.createdAt))
          .limit(20),
        db
          .select()
          .from(payments)
          .where(eq(payments.userId, userId))
          .orderBy(desc(payments.createdAt))
          .limit(20),
        db
          .select()
          .from(referralRelationships)
          .where(eq(referralRelationships.referrerUserId, userId))
          .orderBy(desc(referralRelationships.createdAt))
          .limit(20),
        db
          .select({ code: referralCodes.code, usedCount: referralCodes.usedCount })
          .from(referralCodes)
          .where(eq(referralCodes.ownerUserId, userId))
          .limit(1),
        db
          .select()
          .from(supportTickets)
          .where(eq(supportTickets.userId, userId))
          .orderBy(desc(supportTickets.createdAt))
          .limit(10),
      ]);

      res.json({
        user,
        profile: profile ?? null,
        telegramAccount: telegramAccount ?? null,
        wallet: wallet
          ? {
              ...wallet,
              balance: Number(wallet.balance),
              reservedBalance: Number(wallet.reservedBalance),
              lifetimeEarned: Number(wallet.lifetimeEarned),
              lifetimeSpent: Number(wallet.lifetimeSpent),
            }
          : null,
        limitOverride: limitOverride ?? null,
        subscriptions: subscriptionsList,
        creditTransactions: ledger.map((l) => ({
          ...l,
          amount: Number(l.amount),
          balanceBefore: Number(l.balanceBefore),
          balanceAfter: Number(l.balanceAfter),
        })),
        recentRequests: recentRequests.map((r) => ({
          ...r,
          creditsCharged: Number(r.creditsCharged),
          costUsd: Number(r.costUsd),
        })),
        payments: userPayments.map((p) => ({
          ...p,
          amount: Number(p.amount),
          discountAmount: Number(p.discountAmount),
        })),
        referral: {
          code: refCode?.code ?? null,
          usedCount: refCode?.usedCount ?? 0,
          invitedCount: referralsSent.length,
          relationships: referralsSent,
        },
        tickets,
      });
    } catch (err) {
      console.error('[users/detail]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت جزئیات کامل کاربر.' });
    }
  });

  router.post(
    '/users/:id/adjust-credits',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      const userId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const parsed = creditAdjustmentSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'اطلاعات نامعتبر است.' });
          return;
        }
        const d = parsed.data;
        const result = await applyWalletCreditChange({
          userId,
          amount: d.amount,
          type: d.type,
          idempotencyKey: `admin_adj:${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          description: d.reason,
          referenceType: 'admin_adjustment',
          referenceId: req.admin!.id,
          adminUserId: req.admin!.id,
        });

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'user.credits_adjusted',
          resourceType: 'credit_wallet',
          resourceId: userId,
          severity: 'warning',
          ipAddress: ip,
          userAgent: ua,
          details: {
            amount: d.amount,
            type: d.type,
            reason: d.reason,
            balanceBefore: result.balanceBefore,
            balanceAfter: result.balanceAfter,
          },
        });

        if (d.type === 'promotional_credit' && d.amount > 0) {
          await sendUserNotification({
            userId,
            templateKey: 'promo_reward',
            dedupKey: `promo:${result.transactionId}`,
            variables: {
              creditsAdded: d.amount,
              reason: d.reason,
              balance: Number(result.balanceAfter.toFixed(2)),
            },
          });
        }

        res.json({ ok: true, result });
      } catch (err) {
        if (err instanceof WalletError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        res.status(500).json({ error: 'خطا در تغییر اعتبار کاربر.' });
      }
    },
  );

  router.post(
    '/users/:id/assign-plan',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      const userId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const parsed = manualPlanAssignSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'اطلاعات نامعتبر است.' });
          return;
        }
        const d = parsed.data;
        const assigned = await activateOrRenewSubscription({
          userId,
          planId: d.planId,
          durationDaysOverride: d.durationDays,
          grantCredits: d.grantCredits,
          adminUserId: req.admin!.id,
          reason: d.reason,
          idempotencyKey: `admin_plan:${userId}:${d.planId}:${Date.now()}`,
        });

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'user.plan_assigned',
          resourceType: 'user_subscription',
          resourceId: assigned.subscription.id,
          severity: 'warning',
          ipAddress: ip,
          userAgent: ua,
          details: {
            userId,
            planId: d.planId,
            planName: assigned.plan.name,
            creditsAdded: assigned.creditsAdded,
            reason: d.reason,
          },
        });

        res.json({ ok: true, subscription: assigned.subscription, plan: assigned.plan });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'خطا در تخصیص پلن.' });
      }
    },
  );

  router.put(
    '/users/:id/limits',
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      const userId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const parsed = userLimitOverrideSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'مقادیر محدودیت نامعتبر است.' });
          return;
        }
        const d = parsed.data;
        const db = getDb();
        const now = new Date();
        const values = {
          userId,
          dailyRequestLimit: d.dailyRequestLimit ?? null,
          monthlyRequestLimit: d.monthlyRequestLimit ?? null,
          dailyTextLimit: d.dailyTextLimit ?? null,
          dailyImageLimit: d.dailyImageLimit ?? null,
          dailyVideoLimit: d.dailyVideoLimit ?? null,
          maxConcurrentTasks: d.maxConcurrentTasks ?? null,
          reason: d.reason ?? '',
          updatedByAdminId: req.admin!.id,
          updatedAt: now,
        };
        const [saved] = await db
          .insert(userLimitOverrides)
          .values(values)
          .onConflictDoUpdate({
            target: userLimitOverrides.userId,
            set: values,
          })
          .returning();

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'user.limits_overridden',
          resourceType: 'user_limit_override',
          resourceId: userId,
          ipAddress: ip,
          userAgent: ua,
          details: values,
        });

        res.json({ ok: true, limitOverride: saved });
      } catch {
        res.status(500).json({ error: 'خطا در ذخیره محدودیت‌های سفارشی کاربر.' });
      }
    },
  );

  router.delete(
    '/users/:id/data',
    requireRole('super_admin'),
    async (req: AdminRequest, res: Response) => {
      const userId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const db = getDb();
        const [deleted] = await db
          .delete(users)
          .where(eq(users.id, userId))
          .returning({ id: users.id, externalUid: users.externalUid });

        if (!deleted) {
          res.status(404).json({ error: 'کاربر یافت نشد.' });
          return;
        }

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'user.data_deleted',
          resourceType: 'user',
          resourceId: deleted.id,
          severity: 'critical',
          ipAddress: ip,
          userAgent: ua,
          details: { externalUid: deleted.externalUid, compliance: 'user_data_deletion' },
        });

        res.json({ ok: true, deletedUserId: deleted.id });
      } catch {
        res.status(500).json({ error: 'خطا در حذف کامل اطلاعات کاربر.' });
      }
    },
  );

  return router;
}
