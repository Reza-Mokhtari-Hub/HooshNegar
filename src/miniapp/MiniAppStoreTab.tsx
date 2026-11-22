import React, { useState } from 'react';
import {
  Wallet,
  Crown,
  Star,
  Gift,
  Check,
  Loader2,
  AlertCircle,
  Ban,
} from 'lucide-react';
import {
  miniAppRequest,
  type MiniAppBootstrap,
  type MiniAppCreditPackage,
  type MiniAppPlan,
} from './miniAppApi';
import { openTelegramStarsInvoice, triggerMiniAppHaptic } from './telegramSdk';

interface MiniAppStoreTabProps {
  bootstrap: MiniAppBootstrap;
  onRefreshBootstrap: () => Promise<void>;
  onWalletUpdated: (wallet: { balance: number; reservedBalance: number }) => void;
}

function formatDateFa(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fa-IR');
}

export function MiniAppStoreTab({
  bootstrap,
  onRefreshBootstrap,
  onWalletUpdated,
}: MiniAppStoreTabProps) {
  const [giftCode, setGiftCode] = useState('');
  const [discountCode, setDiscountCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [cancelingRenew, setCancelingRenew] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  const paidPlans = bootstrap.plans.filter((p) => p.starsPrice > 0);

  const handleRedeemCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!giftCode.trim() || redeeming) return;
    setError('');
    setFeedback('');
    setRedeeming(true);
    triggerMiniAppHaptic('tap');

    try {
      const res = await miniAppRequest<{
        ok: boolean;
        creditsAwarded: number;
        newBalance: number;
      }>('/api/miniapp/coupon', {
        method: 'POST',
        body: { code: giftCode.trim() },
      });
      onWalletUpdated({
        balance: res.newBalance,
        reservedBalance: bootstrap.wallet.reservedBalance,
      });
      setFeedback(`کد هدیه اعمال شد و ${res.creditsAwarded} اعتبار به کیف‌پول شما اضافه گردید.`);
      setGiftCode('');
      triggerMiniAppHaptic('success');
      await onRefreshBootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در اعمال کد هدیه.');
      triggerMiniAppHaptic('error');
    } finally {
      setRedeeming(false);
    }
  };

  const startStarsCheckout = async (opts: {
    kind: 'subscription' | 'credit_package';
    plan?: MiniAppPlan;
    pkg?: MiniAppCreditPackage;
  }) => {
    const itemId = opts.plan?.id ?? opts.pkg?.id ?? '';
    setError('');
    setFeedback('');
    setBuyingId(itemId);
    triggerMiniAppHaptic('tap');

    try {
      const res = await miniAppRequest<{
        ok: boolean;
        invoiceUrl: string;
        starsAmount: number;
        discountStars: number;
      }>('/api/miniapp/invoice', {
        method: 'POST',
        body: {
          kind: opts.kind,
          planId: opts.plan?.id,
          creditPackageId: opts.pkg?.id,
          couponCode: discountCode.trim() || null,
        },
      });

      openTelegramStarsInvoice(res.invoiceUrl, (status) => {
        if (status === 'paid') {
          setFeedback('پرداخت تلگرام استارز با موفقیت انجام شد. کیف‌پول در حال بروزرسانی است.');
          triggerMiniAppHaptic('success');
          void onRefreshBootstrap();
        } else if (status === 'cancelled') {
          setFeedback('پرداخت توسط کاربر لغو شد.');
        } else if (status === 'failed') {
          setError('پرداخت ناموفق بود. در صورت کسر وجه، خودکار بازگشت داده می‌شود.');
          triggerMiniAppHaptic('error');
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در ایجاد فاکتور تلگرام استارز.');
      triggerMiniAppHaptic('error');
    } finally {
      setBuyingId(null);
    }
  };

  const handleCancelAutoRenew = async () => {
    setError('');
    setFeedback('');
    setCancelingRenew(true);
    try {
      const res = await miniAppRequest<{ ok: boolean; messageFa?: string }>(
        '/api/miniapp/subscription/cancel',
        { method: 'POST' },
      );
      setFeedback(res.messageFa || 'تمدید خودکار اشتراک لغو شد.');
      triggerMiniAppHaptic('success');
      await onRefreshBootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در لغو تمدید خودکار.');
    } finally {
      setCancelingRenew(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Wallet & Subscription Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              موجودی قابل استفاده
            </span>
            <Wallet className="w-4 h-4 text-blue-700 dark:text-blue-400" />
          </div>
          <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">
            {bootstrap.wallet.available.toLocaleString('fa-IR')}{' '}
            <span className="text-xs font-normal text-slate-500">اعتبار</span>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            درخواست امروز: {bootstrap.usage.todayRequests.toLocaleString('fa-IR')} از{' '}
            {(bootstrap.plan?.dailyRequestLimit ?? 0).toLocaleString('fa-IR')}
          </div>
        </section>

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              پلن فعال حساب
            </span>
            <Crown className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="text-lg font-bold text-slate-900 dark:text-slate-100">
            {bootstrap.plan?.name ?? 'رایگان'}
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>
              {bootstrap.subscription
                ? `انقضا: ${formatDateFa(bootstrap.subscription.endsAt)}`
                : 'بدون اشتراک دوره‌ای فعال'}
            </span>
            {bootstrap.subscription?.autoRenew && (
              <button
                type="button"
                onClick={() => void handleCancelAutoRenew()}
                disabled={cancelingRenew}
                className="min-h-[44px] px-3 rounded-lg border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-1.5 cursor-pointer"
              >
                <Ban className="w-3.5 h-3.5" />
                <span>لغو تمدید خودکار</span>
              </button>
            )}
          </div>
        </section>
      </div>

      {/* Feedback / Error */}
      {feedback && (
        <div
          role="status"
          className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-200 text-xs flex items-center gap-2"
        >
          <Check className="w-4 h-4 shrink-0" />
          <span>{feedback}</span>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-200 text-xs flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Gift Coupon + Checkout Discount */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        <form onSubmit={(e) => void handleRedeemCoupon(e)} className="space-y-2">
          <label
            htmlFor="miniapp-gift-coupon"
            className="block text-xs font-semibold text-slate-900 dark:text-slate-100"
          >
            کد هدیه شارژ کیف‌پول
          </label>
          <div className="flex items-center gap-2">
            <input
              id="miniapp-gift-coupon"
              type="text"
              dir="ltr"
              value={giftCode}
              onChange={(e) => setGiftCode(e.target.value)}
              placeholder="GIFT2026"
              className="flex-1 min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-mono text-slate-900 dark:text-slate-100"
            />
            <button
              type="submit"
              disabled={redeeming || !giftCode.trim()}
              className="min-h-[44px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-500 dark:disabled:bg-slate-800 dark:disabled:text-slate-400 text-white text-xs font-medium flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed shrink-0"
            >
              {redeeming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Gift className="w-4 h-4" />}
              <span>اعمال کد</span>
            </button>
          </div>
        </form>

        <div className="space-y-2">
          <label
            htmlFor="miniapp-checkout-discount"
            className="block text-xs font-semibold text-slate-900 dark:text-slate-100"
          >
            کد تخفیف خرید استارز (اختیاری)
          </label>
          <input
            id="miniapp-checkout-discount"
            type="text"
            dir="ltr"
            value={discountCode}
            onChange={(e) => setDiscountCode(e.target.value)}
            placeholder="OFF20"
            className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-mono text-slate-900 dark:text-slate-100"
          />
        </div>
      </section>

      {/* Subscription Plans & Credit Packages */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            پلن‌های اشتراک (پرداخت با تلگرام استارز)
          </h2>
          {paidPlans.length === 0 ? (
            <p className="text-xs text-slate-500">در حال حاضر پلن پولی فعالی تعریف نشده است.</p>
          ) : (
            <div className="space-y-3">
              {paidPlans.map((plan) => (
                <div
                  key={plan.id}
                  className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="text-sm font-bold text-slate-900 dark:text-slate-100">
                      {plan.name}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      {plan.creditAllocation.toLocaleString('fa-IR')} اعتبار • {plan.durationDays} روز
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={buyingId === plan.id}
                    onClick={() => void startStarsCheckout({ kind: 'subscription', plan })}
                    className="min-h-[44px] px-3.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium flex items-center gap-1.5 shrink-0 cursor-pointer disabled:opacity-60"
                  >
                    {buyingId === plan.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Star className="w-4 h-4" />
                    )}
                    <span className="tabular-nums">{plan.starsPrice} استارز</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">بسته‌های شارژ اعتبار</h2>
          {bootstrap.creditPackages.length === 0 ? (
            <p className="text-xs text-slate-500">در حال حاضر بسته اعتباری فعالی تعریف نشده است.</p>
          ) : (
            <div className="space-y-3">
              {bootstrap.creditPackages.map((pkg) => (
                <div
                  key={pkg.id}
                  className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="text-sm font-bold text-slate-900 dark:text-slate-100">
                      {pkg.name}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      {(pkg.creditsAmount + pkg.bonusCredits).toLocaleString('fa-IR')} اعتبار کل
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={buyingId === pkg.id}
                    onClick={() => void startStarsCheckout({ kind: 'credit_package', pkg })}
                    className="min-h-[44px] px-3.5 rounded-xl border border-blue-700 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 text-xs font-medium flex items-center gap-1.5 shrink-0 cursor-pointer disabled:opacity-60"
                  >
                    {buyingId === pkg.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Star className="w-4 h-4" />
                    )}
                    <span className="tabular-nums">{pkg.starsPrice} استارز</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Recent Payments */}
      {bootstrap.recentPayments.length > 0 && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">تراکنش‌های اخیر</h2>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {bootstrap.recentPayments.map((pay) => (
              <div
                key={pay.id}
                className="py-2.5 flex items-center justify-between gap-3 text-xs"
              >
                <div className="flex items-center gap-3">
                  <span dir="ltr" className="font-mono text-slate-800 dark:text-slate-200">
                    {pay.orderNumber || pay.id.slice(0, 8)}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">
                    {formatDateFa(pay.createdAt)}
                  </span>
                </div>
                <div className="flex items-center gap-3 tabular-nums">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    {pay.amount} {pay.currency}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">{pay.status}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
