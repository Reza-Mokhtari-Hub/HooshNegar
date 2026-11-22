import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Save, Star, Trash2 } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import {
  COUPON_DISCOUNT_TYPES,
  PLAN_TIERS,
  type CouponDiscountType,
  type PlanTier,
} from '../../shared/validation';
import {
  Button,
  EmptyState,
  FieldLabel,
  Input,
  Modal,
  Select,
  StatusText,
  Surface,
  TableSkeleton,
} from '../ui/primitives';

interface ReferralCodeRow {
  id: string;
  code: string;
  rewardCredits: number;
  maxUses: number | null;
  usedCount: number;
  isActive: boolean;
  createdAt: string;
}

interface ReferralRelationshipRow {
  id: string;
  referrerUserId: string;
  referredUserId: string;
  status: string;
  fraudScore: number;
  fraudFlags: string[];
  createdAt: string;
}

interface CouponRow {
  id: string;
  code: string;
  discountType: CouponDiscountType;
  discountValue: number;
  maxRedemptions: number | null;
  perUserLimit: number;
  minStarsAmount: number;
  redeemedCount: number;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
}

interface ReferralAnalytics {
  totalInvited: number;
  qualifiedCount: number;
  pendingCount: number;
  flaggedCount: number;
  conversionRatePct: number;
  totalCreditsAwarded: number;
  totalSubscriptionDaysAwarded: number;
  referredUsersStarsRevenue: number;
  referredUsersPaidOrders: number;
}

interface ReferralProgramSettingsDTO {
  isActive: boolean;
  inviterRewardType: 'credits' | 'subscription_days' | 'promotional_credits';
  inviterBonusCredits: number;
  inviterFreeDays: number;
  invitedBonusCredits: number;
  requirePurchase: boolean;
  minPurchaseStars: number;
  minPlanTier: PlanTier;
  maxReferralsPerAccount: number;
  maxRewardCreditsPerAccount: number;
  fraudVelocityLimitPerHour: number;
}

const COUPON_TYPE_LABELS: Record<CouponDiscountType, { fa: string; en: string }> = {
  percentage: { fa: 'تخفیف درصدی روی استارز (%)', en: 'Percentage Discount (%)' },
  fixed: { fa: 'تخفیف ثابت استارز (XTR)', en: 'Fixed Stars Discount' },
  fixed_credits: { fa: 'کد شارژ اعتبار ثابت', en: 'Fixed Credit Code' },
  gift_credits: { fa: 'کد هدیه اعتبار', en: 'Gift Credit Code' },
  promotional: { fa: 'کد تبلیغاتی اعتبار', en: 'Promotional Credits' },
};

export function ReferralsSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [codes, setCodes] = useState<ReferralCodeRow[]>([]);
  const [relationships, setRelationships] = useState<ReferralRelationshipRow[]>([]);
  const [coupons, setCoupons] = useState<CouponRow[]>([]);
  const [analytics, setAnalytics] = useState<ReferralAnalytics | null>(null);
  const [settings, setSettings] = useState<ReferralProgramSettingsDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [codeModalOpen, setCodeModalOpen] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [rewardCredits, setRewardCredits] = useState(50);
  const [maxUses, setMaxUses] = useState('');

  const [couponModalOpen, setCouponModalOpen] = useState(false);
  const [couponCode, setCouponCode] = useState('');
  const [discountType, setDiscountType] = useState<CouponDiscountType>('percentage');
  const [discountValue, setDiscountValue] = useState(20);
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [perUserLimit, setPerUserLimit] = useState(1);
  const [minStarsAmount, setMinStarsAmount] = useState(0);
  const [expiresAt, setExpiresAt] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [refRes, analyticsRes, settingsRes] = await Promise.all([
        apiRequest<{
          referralCodes: ReferralCodeRow[];
          relationships: ReferralRelationshipRow[];
          coupons: CouponRow[];
        }>('/api/referrals'),
        apiRequest<{ analytics: ReferralAnalytics }>('/api/referrals/analytics'),
        apiRequest<{ settings: ReferralProgramSettingsDTO }>('/api/referrals/settings'),
      ]);
      setCodes(refRes.referralCodes);
      setRelationships(refRes.relationships);
      setCoupons(refRes.coupons);
      setAnalytics(analyticsRes.analytics);
      setSettings(settingsRes.settings);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در دریافت داده‌های معرفی' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProgramSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSavingSettings(true);
    setFeedback(null);
    try {
      await apiRequest('/api/referrals/settings', { method: 'PUT', body: settings });
      setFeedback({ tone: 'success', text: locale === 'fa' ? 'قوانین و پاداش‌های برنامه معرفی ذخیره شد.' : 'Referral program rules saved.' });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ذخیره قوانین معرفی' });
    } finally {
      setSavingSettings(false);
    }
  };

  const createReferralCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/referrals/codes', {
        method: 'POST',
        body: {
          code: newCode.trim(),
          rewardCredits: Number(rewardCredits),
          maxUses: maxUses.trim() ? Number(maxUses) : null,
          isActive: true,
        },
      });
      setCodeModalOpen(false);
      setNewCode('');
      setMaxUses('');
      setFeedback({ tone: 'success', text: locale === 'fa' ? 'کد معرفی جدید ایجاد شد.' : 'Referral code created.' });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ایجاد کد معرفی' });
    }
  };

  const createCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/coupons', {
        method: 'POST',
        body: {
          code: couponCode.trim(),
          discountType,
          discountValue: Number(discountValue),
          maxRedemptions: maxRedemptions.trim() ? Number(maxRedemptions) : null,
          perUserLimit: Number(perUserLimit),
          minStarsAmount: Number(minStarsAmount),
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          isActive: true,
        },
      });
      setCouponModalOpen(false);
      setCouponCode('');
      setMaxRedemptions('');
      setExpiresAt('');
      setFeedback({ tone: 'success', text: locale === 'fa' ? 'کوپن / کد هدیه جدید ایجاد شد.' : 'Coupon / gift code created.' });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ایجاد کوپن' });
    }
  };

  const toggleCoupon = async (cp: CouponRow) => {
    try {
      await apiRequest(`/api/coupons/${cp.id}`, { method: 'PATCH', body: { isActive: !cp.isActive } });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در تغییر وضعیت کوپن' });
    }
  };

  const deleteCoupon = async (cp: CouponRow) => {
    try {
      await apiRequest(`/api/coupons/${cp.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در حذف کوپن' });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.referrals}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'تنظیمات کامل برنامه معرفی دوستان، ضدتقلب (Fraud Scoring)، آمار تبدیل و مدیریت کوپن‌های تخفیف و کدهای هدیه اعتبار.'
              : 'Configurable referral engine, anti-fraud scoring, conversion analytics, discount coupons, and gift credit codes.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setCouponModalOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            <span>{locale === 'fa' ? 'کوپن / کد هدیه جدید' : 'New Coupon / Gift'}</span>
          </Button>
          <Button size="sm" onClick={() => setCodeModalOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            <span>{locale === 'fa' ? 'کد معرفی کمپین' : 'New Referral Code'}</span>
          </Button>
        </div>
      </div>

      {feedback && (
        <div
          role="status"
          className={`p-3.5 rounded-xl border text-xs ${
            feedback.tone === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Referral Analytics KPIs */}
      {analytics && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Surface className="p-4">
            <div className="text-[11px] text-slate-500">{locale === 'fa' ? 'کل دعوت‌شده‌ها / تاییدشده' : 'Total Invited / Qualified'}</div>
            <div className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {formatNumber(analytics.totalInvited, locale)} / {formatNumber(analytics.qualifiedCount, locale)}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
              {locale === 'fa' ? `نرخ تبدیل: ${analytics.conversionRatePct}%` : `Conversion: ${analytics.conversionRatePct}%`}
            </div>
          </Surface>
          <Surface className="p-4">
            <div className="text-[11px] text-slate-500">{locale === 'fa' ? 'پاداش اعتبار / روز اعطاشده' : 'Credits / Days Awarded'}</div>
            <div className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {formatNumber(analytics.totalCreditsAwarded, locale)}{' '}
              <span className="text-xs font-normal text-slate-500">{locale === 'fa' ? 'اعتبار' : 'cr'}</span>
              {' · '}
              {formatNumber(analytics.totalSubscriptionDaysAwarded, locale)}{' '}
              <span className="text-xs font-normal text-slate-500">{locale === 'fa' ? 'روز' : 'd'}</span>
            </div>
          </Surface>
          <Surface className="p-4">
            <div className="text-[11px] text-slate-500">{locale === 'fa' ? 'درآمد استارز از کاربران معرفی‌شده' : 'Stars Revenue from Referrals'}</div>
            <div className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100 mt-1 flex items-center gap-1.5">
              <span>{formatNumber(analytics.referredUsersStarsRevenue, locale)}</span>
              <Star className="w-4 h-4 text-amber-500 fill-amber-400 shrink-0" />
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
              {formatNumber(analytics.referredUsersPaidOrders, locale)} {locale === 'fa' ? 'سفارش موفق' : 'paid orders'}
            </div>
          </Surface>
          <Surface className="p-4">
            <div className="text-[11px] text-slate-500">{locale === 'fa' ? 'موارد مشکوک / ضدتقلب' : 'Flagged (Anti-Fraud)'}</div>
            <div className={`text-xl font-bold tabular-nums mt-1 ${analytics.flaggedCount > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-slate-900 dark:text-slate-100'}`}>
              {formatNumber(analytics.flaggedCount, locale)}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
              {locale === 'fa' ? `در انتظار خرید: ${formatNumber(analytics.pendingCount, locale)}` : `Pending: ${analytics.pendingCount}`}
            </div>
          </Surface>
        </div>
      )}

      {/* Referral Program Settings Form */}
      {settings && (
        <form onSubmit={saveProgramSettings}>
          <Surface className="p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {locale === 'fa' ? 'تنظیمات و قوانین برنامه معرفی دوستان' : 'Referral Program Rules & Anti-Fraud'}
                </h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {locale === 'fa'
                    ? 'جلوگیری از معرفی به خود (Self-referral) و ثبت‌نام تکراری به صورت خودکار فعال است.'
                    : 'Self-referral and duplicate referral attribution are blocked automatically.'}
                </p>
              </div>
              <Button type="submit" size="sm" disabled={savingSettings}>
                <Save className="w-3.5 h-3.5" />
                <span>{savingSettings ? t.common.saving : t.common.save}</span>
              </Button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <FieldLabel htmlFor="ref-rtype">{locale === 'fa' ? 'نوع پاداش معرف' : 'Inviter Reward Type'}</FieldLabel>
                <Select
                  id="ref-rtype"
                  value={settings.inviterRewardType}
                  onChange={(e) =>
                    setSettings({ ...settings, inviterRewardType: e.target.value as ReferralProgramSettingsDTO['inviterRewardType'] })
                  }
                >
                  <option value="credits">{locale === 'fa' ? 'اعتبار کیف‌پول' : 'Wallet Credits'}</option>
                  <option value="subscription_days">{locale === 'fa' ? 'روز اشتراک رایگان' : 'Free Subscription Days'}</option>
                  <option value="promotional_credits">{locale === 'fa' ? 'اعتبار تبلیغاتی' : 'Promotional Credits'}</option>
                </Select>
              </div>
              <div>
                <FieldLabel htmlFor="ref-inv-cr">{locale === 'fa' ? 'پاداش معرف (اعتبار)' : 'Inviter Credits'}</FieldLabel>
                <Input
                  id="ref-inv-cr"
                  type="number"
                  min={0}
                  value={settings.inviterBonusCredits}
                  onChange={(e) => setSettings({ ...settings, inviterBonusCredits: Number(e.target.value) })}
                />
              </div>
              <div>
                <FieldLabel htmlFor="ref-inv-days">{locale === 'fa' ? 'روز رایگان معرف' : 'Inviter Free Days'}</FieldLabel>
                <Input
                  id="ref-inv-days"
                  type="number"
                  min={0}
                  value={settings.inviterFreeDays}
                  onChange={(e) => setSettings({ ...settings, inviterFreeDays: Number(e.target.value) })}
                />
              </div>
              <div>
                <FieldLabel htmlFor="ref-new-cr">{locale === 'fa' ? 'پاداش عضو جدید' : 'Invited Bonus Credits'}</FieldLabel>
                <Input
                  id="ref-new-cr"
                  type="number"
                  min={0}
                  value={settings.invitedBonusCredits}
                  onChange={(e) => setSettings({ ...settings, invitedBonusCredits: Number(e.target.value) })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <FieldLabel htmlFor="ref-min-stars">{locale === 'fa' ? 'حداقل خرید (استارز)' : 'Min Purchase (XTR)'}</FieldLabel>
                <Input
                  id="ref-min-stars"
                  type="number"
                  min={0}
                  value={settings.minPurchaseStars}
                  onChange={(e) => setSettings({ ...settings, minPurchaseStars: Number(e.target.value) })}
                />
              </div>
              <div>
                <FieldLabel htmlFor="ref-min-tier">{locale === 'fa' ? 'حداقل سطح پلن' : 'Min Plan Tier'}</FieldLabel>
                <Select
                  id="ref-min-tier"
                  value={settings.minPlanTier}
                  onChange={(e) => setSettings({ ...settings, minPlanTier: e.target.value as PlanTier })}
                >
                  {PLAN_TIERS.map((tier) => (
                    <option key={tier} value={tier}>{t.planTiers[tier]}</option>
                  ))}
                </Select>
              </div>
              <div>
                <FieldLabel htmlFor="ref-max-acc">{locale === 'fa' ? 'سقف دعوت هر کاربر' : 'Max Referrals / User'}</FieldLabel>
                <Input
                  id="ref-max-acc"
                  type="number"
                  min={1}
                  value={settings.maxReferralsPerAccount}
                  onChange={(e) => setSettings({ ...settings, maxReferralsPerAccount: Number(e.target.value) })}
                />
              </div>
              <div>
                <FieldLabel htmlFor="ref-max-cr">{locale === 'fa' ? 'سقف اعتبار پاداش' : 'Max Reward Credits'}</FieldLabel>
                <Input
                  id="ref-max-cr"
                  type="number"
                  min={0}
                  value={settings.maxRewardCreditsPerAccount}
                  onChange={(e) => setSettings({ ...settings, maxRewardCreditsPerAccount: Number(e.target.value) })}
                />
              </div>
              <div>
                <FieldLabel htmlFor="ref-vel">{locale === 'fa' ? 'سقف سرعت/ساعت (ضدتقلب)' : 'Velocity / Hr (Fraud)'}</FieldLabel>
                <Input
                  id="ref-vel"
                  type="number"
                  min={1}
                  value={settings.fraudVelocityLimitPerHour}
                  onChange={(e) => setSettings({ ...settings, fraudVelocityLimitPerHour: Number(e.target.value) })}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-6 pt-1">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.isActive}
                  onChange={(e) => setSettings({ ...settings, isActive: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300 text-blue-700"
                />
                <span>{locale === 'fa' ? 'برنامه معرفی دوستان فعال باشد' : 'Referral program active'}</span>
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.requirePurchase}
                  onChange={(e) => setSettings({ ...settings, requirePurchase: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300 text-blue-700"
                />
                <span>{locale === 'fa' ? 'اعطای پاداش مشروط به نخستین خرید موفق استارز (Purchase-qualified)' : 'Require qualifying Stars purchase before awarding'}</span>
              </label>
            </div>
          </Surface>
        </form>
      )}

      {/* Coupons & Referral Codes Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Surface className="overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {locale === 'fa' ? 'کوپن‌های تخفیف و کدهای هدیه اعتبار' : 'Coupons & Gift Credit Codes'}
            </h2>
          </div>
          {loading ? (
            <TableSkeleton rows={3} cols={3} />
          ) : coupons.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'کوپن یا کد هدیه‌ای ثبت نشده است' : 'No coupons yet'}
              description={
                locale === 'fa'
                  ? 'کدهای تخفیف درصدی/ثابت روی استارز یا کدهای هدیه شارژ اعتبار بسازید.'
                  : 'Create server-validated percentage/fixed Stars discounts or gift credit codes.'
              }
            />
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
              {coupons.map((cp) => (
                <div key={cp.id} className="px-5 py-3.5 flex items-center justify-between gap-3">
                  <div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                      <span dir="ltr" className="inline-block">{cp.code}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {COUPON_TYPE_LABELS[cp.discountType]?.[locale] ?? cp.discountType}:{' '}
                      <strong>
                        {cp.discountType === 'percentage' ? `${cp.discountValue}%` : formatNumber(cp.discountValue, locale)}
                      </strong>{' '}
                      · {cp.redeemedCount}/{cp.maxRedemptions ?? '∞'} (max {cp.perUserLimit}/user)
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => toggleCoupon(cp)} className="cursor-pointer">
                      <StatusText tone={cp.isActive ? 'success' : 'neutral'}>
                        {cp.isActive ? t.common.active : t.common.inactive}
                      </StatusText>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteCoupon(cp)}
                      aria-label={t.common.delete}
                      className="text-red-600"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Surface>

        <Surface className="overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {locale === 'fa' ? 'کدهای معرفی و روابط اخیر (ضدتقلب)' : 'Referral Codes & Recent Attributions'}
            </h2>
          </div>
          {loading ? (
            <TableSkeleton rows={3} cols={3} />
          ) : codes.length === 0 && relationships.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'رکورد معرفی ثبت نشده است' : 'No referral records yet'}
              description={
                locale === 'fa'
                  ? 'کدهای معرفی اختصاصی کاربران و کمپین‌ها به همراه امتیاز ریسک ضدتقلب اینجا ثبت می‌شوند.'
                  : 'User deep-link referral codes and fraud-scored attributions appear here.'
              }
            />
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs max-h-80 overflow-y-auto">
              {codes.map((c) => (
                <div key={c.id} className="px-5 py-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                      <span dir="ltr" className="inline-block">{c.code}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {formatNumber(c.rewardCredits, locale)} {locale === 'fa' ? 'اعتبار' : 'credits'} · {c.usedCount}/{c.maxUses ?? '∞'}
                    </div>
                  </div>
                  <StatusText tone={c.isActive ? 'success' : 'neutral'}>
                    {c.isActive ? t.common.active : t.common.inactive}
                  </StatusText>
                </div>
              ))}
              {relationships.slice(0, 10).map((rel) => (
                <div key={rel.id} className="px-5 py-3 flex items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-950/30">
                  <div>
                    <div className="font-mono text-[11px] text-slate-700 dark:text-slate-300">
                      <span dir="ltr">{rel.referrerUserId.slice(0, 8)} → {rel.referredUserId.slice(0, 8)}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {formatDateTime(rel.createdAt, locale)} · Fraud Score: {rel.fraudScore}
                      {rel.fraudFlags?.length ? ` (${rel.fraudFlags.join(', ')})` : ''}
                    </div>
                  </div>
                  <StatusText tone={rel.status === 'rewarded' ? 'success' : rel.status === 'flagged' ? 'danger' : 'warning'}>
                    {rel.status}
                  </StatusText>
                </div>
              ))}
            </div>
          )}
        </Surface>
      </div>

      {/* Create Referral Code Modal */}
      <Modal
        open={codeModalOpen}
        onClose={() => setCodeModalOpen(false)}
        maxWidth="max-w-md"
        title={locale === 'fa' ? 'ایجاد کد معرفی کمپین' : 'Create Referral Code'}
      >
        <form onSubmit={createReferralCode} className="space-y-4">
          <div>
            <FieldLabel htmlFor="ref-code" required>{locale === 'fa' ? 'کد معرفی (انگلیسی)' : 'Code'}</FieldLabel>
            <Input
              id="ref-code"
              dir="ltr"
              required
              value={newCode}
              onChange={(e) => setNewCode(e.target.value.toUpperCase())}
              placeholder="WELCOME50"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="ref-reward" required>{locale === 'fa' ? 'پاداش اعتبار' : 'Reward Credits'}</FieldLabel>
              <Input
                id="ref-reward"
                type="number"
                min={1}
                required
                value={rewardCredits}
                onChange={(e) => setRewardCredits(Number(e.target.value))}
              />
            </div>
            <div>
              <FieldLabel htmlFor="ref-max">{locale === 'fa' ? 'حداکثر استفاده' : 'Max Uses'}</FieldLabel>
              <Input id="ref-max" type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="∞" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <Button variant="outline" onClick={() => setCodeModalOpen(false)}>{t.common.cancel}</Button>
            <Button type="submit">{t.common.create}</Button>
          </div>
        </form>
      </Modal>

      {/* Create Coupon / Gift Code Modal */}
      <Modal
        open={couponModalOpen}
        onClose={() => setCouponModalOpen(false)}
        maxWidth="max-w-lg"
        title={locale === 'fa' ? 'ایجاد کوپن تخفیف یا کد هدیه اعتبار' : 'Create Coupon or Gift Code'}
      >
        <form onSubmit={createCoupon} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="cp-code" required>{locale === 'fa' ? 'کد (انگلیسی)' : 'Code'}</FieldLabel>
              <Input
                id="cp-code"
                dir="ltr"
                required
                value={couponCode}
                onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                placeholder="GIFT200 / LAUNCH20"
              />
            </div>
            <div>
              <FieldLabel htmlFor="cp-type">{locale === 'fa' ? 'نوع کد' : 'Coupon Type'}</FieldLabel>
              <Select
                id="cp-type"
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as CouponDiscountType)}
              >
                {COUPON_DISCOUNT_TYPES.map((dt) => (
                  <option key={dt} value={dt}>{COUPON_TYPE_LABELS[dt][locale]}</option>
                ))}
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <FieldLabel htmlFor="cp-val" required>{locale === 'fa' ? 'مقدار' : 'Value'}</FieldLabel>
              <Input
                id="cp-val"
                type="number"
                min={1}
                required
                value={discountValue}
                onChange={(e) => setDiscountValue(Number(e.target.value))}
              />
            </div>
            <div>
              <FieldLabel htmlFor="cp-max">{locale === 'fa' ? 'سقف کل' : 'Max Total'}</FieldLabel>
              <Input
                id="cp-max"
                type="number"
                min={1}
                value={maxRedemptions}
                onChange={(e) => setMaxRedemptions(e.target.value)}
                placeholder="∞"
              />
            </div>
            <div>
              <FieldLabel htmlFor="cp-per">{locale === 'fa' ? 'سقف هر کاربر' : 'Per User'}</FieldLabel>
              <Input
                id="cp-per"
                type="number"
                min={1}
                value={perUserLimit}
                onChange={(e) => setPerUserLimit(Number(e.target.value))}
              />
            </div>
            <div>
              <FieldLabel htmlFor="cp-min-xtr">{locale === 'fa' ? 'حداقل XTR' : 'Min XTR'}</FieldLabel>
              <Input
                id="cp-min-xtr"
                type="number"
                min={0}
                value={minStarsAmount}
                onChange={(e) => setMinStarsAmount(Number(e.target.value))}
              />
            </div>
          </div>
          <div>
            <FieldLabel htmlFor="cp-exp">{locale === 'fa' ? 'تاریخ انقضا (اختیاری)' : 'Expiration Date (Optional)'}</FieldLabel>
            <Input id="cp-exp" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <Button variant="outline" onClick={() => setCouponModalOpen(false)}>{t.common.cancel}</Button>
            <Button type="submit">{t.common.create}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
