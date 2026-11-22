import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Search, SlidersHorizontal, Trash2 } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import type { PlanRecord } from './PlansSection';
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

interface UserRow {
  id: string;
  email: string | null;
  phoneNumber: string | null;
  status: 'active' | 'suspended' | 'banned' | 'pending';
  locale: string;
  lastActiveAt: string | null;
  createdAt: string;
  displayName: string | null;
  telegramUserId: number | null;
  telegramUsername: string | null;
  walletBalance: number;
  activePlanName: string | null;
  activePlanTier: string | null;
  subscriptionEndsAt: string | null;
}

interface UserDetailResponse {
  user: {
    id: string;
    email: string | null;
    status: 'active' | 'suspended' | 'banned' | 'pending';
    locale: string;
    createdAt: string;
    lastActiveAt: string | null;
  };
  profile: { displayName: string; firstName: string; lastName: string } | null;
  telegramAccount: { telegramUserId: number; username: string | null; languageCode: string } | null;
  wallet: {
    balance: number;
    reservedBalance: number;
    lifetimeEarned: number;
    lifetimeSpent: number;
  } | null;
  limitOverride: {
    dailyRequestLimit: number | null;
    monthlyRequestLimit: number | null;
    dailyTextLimit: number | null;
    dailyImageLimit: number | null;
    dailyVideoLimit: number | null;
    maxConcurrentTasks: number | null;
    reason: string;
  } | null;
  subscriptions: Array<{
    id: string;
    planId: string;
    planName: string;
    planTier: string;
    status: string;
    startsAt: string;
    endsAt: string;
    autoRenew: boolean;
  }>;
  creditTransactions: Array<{
    id: string;
    type: string;
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
    description: string;
    createdAt: string;
  }>;
  recentRequests: Array<{
    id: string;
    capability: string;
    status: string;
    modelName: string | null;
    creditsCharged: number;
    costUsd: number;
    latencyMs: number | null;
    createdAt: string;
  }>;
  payments: Array<{
    id: string;
    orderNumber: string | null;
    paymentType: string;
    amount: number;
    currency: string;
    status: string;
    createdAt: string;
  }>;
  referral: {
    code: string | null;
    usedCount: number;
    invitedCount: number;
  };
}

export function UsersSection({
  locale,
  adminRole,
}: {
  locale: Locale;
  adminRole?: string;
}) {
  const t = DICTIONARIES[locale];
  const [users, setUsers] = useState<UserRow[]>([]);
  const [plans, setPlans] = useState<PlanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<'actions' | 'billing' | 'activity'>('actions');

  // Admin action forms
  const [creditAmount, setCreditAmount] = useState(100);
  const [creditType, setCreditType] = useState<'adjustment' | 'promotional_credit' | 'grant' | 'refund'>('adjustment');
  const [creditReason, setCreditReason] = useState('');
  const [planId, setPlanId] = useState('');
  const [planDuration, setPlanDuration] = useState('');
  const [planGrantCredits, setPlanGrantCredits] = useState(true);
  const [planReason, setPlanReason] = useState('');

  const [limDailyReq, setLimDailyReq] = useState('');
  const [limMonthlyReq, setLimMonthlyReq] = useState('');
  const [limDailyImg, setLimDailyImg] = useState('');
  const [limDailyVid, setLimDailyVid] = useState('');
  const [limConcurrent, setLimConcurrent] = useState('');
  const [limReason, setLimReason] = useState('');

  const [actionBusy, setActionBusy] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set('q', search.trim());
      if (statusFilter !== 'all') qs.set('status', statusFilter);
      const [usersRes, plansRes] = await Promise.all([
        apiRequest<{ users: UserRow[] }>(`/api/users${qs.toString() ? `?${qs.toString()}` : ''}`),
        apiRequest<{ plans: PlanRecord[] }>('/api/plans'),
      ]);
      setUsers(usersRes.users);
      setPlans(plansRes.plans);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در دریافت فهرست کاربران' });
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadUserDetail = useCallback(async (userId: string) => {
    setSelectedUserId(userId);
    setDetailLoading(true);
    setConfirmDeleteOpen(false);
    try {
      const res = await apiRequest<UserDetailResponse>(`/api/users/${userId}/detail`);
      setDetail(res);
      setLimDailyReq(res.limitOverride?.dailyRequestLimit?.toString() ?? '');
      setLimMonthlyReq(res.limitOverride?.monthlyRequestLimit?.toString() ?? '');
      setLimDailyImg(res.limitOverride?.dailyImageLimit?.toString() ?? '');
      setLimDailyVid(res.limitOverride?.dailyVideoLimit?.toString() ?? '');
      setLimConcurrent(res.limitOverride?.maxConcurrentTasks?.toString() ?? '');
      setLimReason(res.limitOverride?.reason ?? '');
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در دریافت جزئیات کاربر' });
      setSelectedUserId(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleStatusChange = async (userId: string, status: UserRow['status']) => {
    try {
      await apiRequest(`/api/users/${userId}/status`, { method: 'PATCH', body: { status } });
      setFeedback({ tone: 'success', text: locale === 'fa' ? 'وضعیت کاربر بروزرسانی شد.' : 'User status updated.' });
      await load();
      if (selectedUserId === userId) await loadUserDetail(userId);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در تغییر وضعیت کاربر' });
    }
  };

  const handleAdjustCredits = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId) return;
    setActionBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/users/${selectedUserId}/adjust-credits`, {
        method: 'POST',
        body: { amount: Number(creditAmount), type: creditType, reason: creditReason.trim() },
      });
      setCreditReason('');
      setFeedback({ tone: 'success', text: locale === 'fa' ? 'موجودی کیف‌پول اعتبار با ثبت گزارش ممیزی بروزرسانی شد.' : 'Credit balance adjusted and audited.' });
      await Promise.all([load(), loadUserDetail(selectedUserId)]);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در تغییر اعتبار' });
    } finally {
      setActionBusy(false);
    }
  };

  const handleAssignPlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId || !planId) return;
    setActionBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/users/${selectedUserId}/assign-plan`, {
        method: 'POST',
        body: {
          planId,
          durationDays: planDuration.trim() ? Number(planDuration) : undefined,
          grantCredits: planGrantCredits,
          reason: planReason.trim(),
        },
      });
      setPlanReason('');
      setPlanDuration('');
      setFeedback({ tone: 'success', text: locale === 'fa' ? 'پلن اشتراک به صورت دستی به کاربر اختصاص یافت.' : 'Subscription plan assigned.' });
      await Promise.all([load(), loadUserDetail(selectedUserId)]);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در تخصیص پلن' });
    } finally {
      setActionBusy(false);
    }
  };

  const handleSaveLimits = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId) return;
    setActionBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/users/${selectedUserId}/limits`, {
        method: 'PUT',
        body: {
          dailyRequestLimit: limDailyReq.trim() ? Number(limDailyReq) : null,
          monthlyRequestLimit: limMonthlyReq.trim() ? Number(limMonthlyReq) : null,
          dailyImageLimit: limDailyImg.trim() ? Number(limDailyImg) : null,
          dailyVideoLimit: limDailyVid.trim() ? Number(limDailyVid) : null,
          maxConcurrentTasks: limConcurrent.trim() ? Number(limConcurrent) : null,
          reason: limReason.trim(),
        },
      });
      setFeedback({ tone: 'success', text: locale === 'fa' ? 'محدودیت‌های سفارشی کاربر ذخیره شد.' : 'Per-user limit overrides saved.' });
      await loadUserDetail(selectedUserId);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ذخیره محدودیت‌ها' });
    } finally {
      setActionBusy(false);
    }
  };

  const handleDeleteUserData = async () => {
    if (!selectedUserId) return;
    setActionBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/users/${selectedUserId}/data`, { method: 'DELETE' });
      setSelectedUserId(null);
      setDetail(null);
      setConfirmDeleteOpen(false);
      setFeedback({ tone: 'success', text: locale === 'fa' ? 'تمامی داده‌های کاربر مطابق درخواست حذف دائم پاک شد.' : 'User data permanently deleted.' });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در حذف کاربر' });
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.users}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'مدیریت کامل کاربران، تعلیق/فعال‌سازی، تنظیم حسابرسی‌شده اعتبار و هدیه، تخصیص دستی پلن، محدودیت‌های سفارشی و حذف داده.'
              : 'Full user administration: status controls, audited credit adjustments, manual plan assignments, custom quota overrides, and user data deletion.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute top-3 start-3 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={locale === 'fa' ? 'جستجو نام، ایمیل، آیدی تلگرام یا پلن...' : 'Search name, email, Telegram ID, or plan...'}
            className="ps-9"
          />
        </div>
        <div className="w-full sm:w-48">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t.common.status}>
            <option value="all">{t.common.all}</option>
            <option value="active">{t.common.active}</option>
            <option value="suspended">{locale === 'fa' ? 'معلق' : 'Suspended'}</option>
            <option value="banned">{locale === 'fa' ? 'مسدود' : 'Banned'}</option>
          </Select>
        </div>
      </div>

      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={6} />
        ) : users.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'کاربری یافت نشد' : 'No users found'}
            description={
              locale === 'fa'
                ? 'کاربرانی که ربات تلگرام را استارت می‌کنند یا ثبت‌نام کرده‌اند اینجا نمایش داده می‌شوند.'
                : 'Users who start the Telegram bot or register on the platform appear here.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کاربر' : 'User'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'حساب تلگرام' : 'Telegram'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'اشتراک فعال' : 'Active Plan'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'اعتبار' : 'Credits'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {u.displayName || u.email || u.id.slice(0, 8)}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {formatDateTime(u.createdAt, locale)}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-700 dark:text-slate-300">
                      <span dir="ltr" className="inline-block">
                        {u.telegramUsername ? `@${u.telegramUsername}` : u.telegramUserId ?? '—'}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-slate-800 dark:text-slate-200">
                        {u.activePlanName ?? (locale === 'fa' ? 'رایگان / بدون اشتراک' : 'Free / None')}
                      </div>
                      {u.subscriptionEndsAt && (
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {locale === 'fa' ? 'تا' : 'Until'} {formatDateTime(u.subscriptionEndsAt, locale)}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                      {formatNumber(u.walletBalance, locale)}
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusText tone={u.status === 'active' ? 'success' : 'danger'}>{u.status}</StatusText>
                    </td>
                    <td className="py-3.5 px-4 text-end">
                      <Button variant="outline" size="sm" onClick={() => loadUserDetail(u.id)}>
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                        <span>{locale === 'fa' ? 'مدیریت' : 'Manage'}</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      {/* Complete User Detail & Admin Actions Modal */}
      <Modal
        open={Boolean(selectedUserId)}
        onClose={() => {
          setSelectedUserId(null);
          setDetail(null);
        }}
        maxWidth="max-w-4xl"
        title={
          detail
            ? `${locale === 'fa' ? 'مدیریت کاربر:' : 'Manage User:'} ${detail.profile?.displayName || detail.user.email || detail.user.id.slice(0, 8)}`
            : locale === 'fa'
              ? 'جزئیات کاربر'
              : 'User Detail'
        }
      >
        {detailLoading || !detail ? (
          <TableSkeleton rows={4} cols={3} />
        ) : (
          <div className="space-y-5">
            {/* Summary Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
                <div className="text-[11px] text-slate-500">{locale === 'fa' ? 'موجودی اعتبار' : 'Credit Balance'}</div>
                <div className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100 mt-0.5">
                  {formatNumber(detail.wallet?.balance ?? 0, locale)}
                </div>
              </div>
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
                <div className="text-[11px] text-slate-500">{locale === 'fa' ? 'حساب تلگرام' : 'Telegram'}</div>
                <div className="text-xs font-mono font-semibold text-slate-900 dark:text-slate-100 mt-1">
                  <span dir="ltr" className="inline-block">
                    {detail.telegramAccount?.username
                      ? `@${detail.telegramAccount.username}`
                      : detail.telegramAccount?.telegramUserId ?? '—'}
                  </span>
                </div>
              </div>
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
                <div className="text-[11px] text-slate-500">{locale === 'fa' ? 'زیرمجموعه‌ها' : 'Referrals'}</div>
                <div className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100 mt-0.5">
                  {formatNumber(detail.referral.invitedCount, locale)}
                </div>
              </div>
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
                <div className="text-[11px] text-slate-500">{t.common.status}</div>
                <div className="mt-1">
                  <Select
                    value={detail.user.status}
                    onChange={(e) => handleStatusChange(detail.user.id, e.target.value as UserRow['status'])}
                    className="h-8 text-xs"
                  >
                    <option value="active">active</option>
                    <option value="suspended">suspended</option>
                    <option value="banned">banned</option>
                  </Select>
                </div>
              </div>
            </div>

            {/* Modal Sub-tabs */}
            <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
              {(['actions', 'billing', 'activity'] as const).map((tabKey) => (
                <button
                  key={tabKey}
                  type="button"
                  onClick={() => setDetailTab(tabKey)}
                  className={`px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
                    detailTab === tabKey
                      ? 'border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-400'
                      : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {tabKey === 'actions'
                    ? locale === 'fa'
                      ? 'اقدامات مدیریتی'
                      : 'Admin Actions'
                    : tabKey === 'billing'
                      ? locale === 'fa'
                        ? 'پرداخت‌ها و کیف‌پول'
                        : 'Payments & Wallet'
                      : locale === 'fa'
                        ? 'درخواست‌های AI و اشتراک‌ها'
                        : 'AI Requests & Subs'}
                </button>
              ))}
            </div>

            {detailTab === 'actions' && (
              <div className="space-y-5">
                {/* 1. Audited Credit Adjustment / Promo Reward */}
                <form
                  onSubmit={handleAdjustCredits}
                  className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3"
                >
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {locale === 'fa' ? 'افزایش / کسر اعتبار یا اعطای پاداش تبلیغاتی (حسابرسی‌شده)' : 'Audited Credit Adjustment / Promo Reward'}
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <FieldLabel htmlFor="adj-amt" required>{locale === 'fa' ? 'مقدار (+ یا -)' : 'Delta (+/-)'}</FieldLabel>
                      <Input
                        id="adj-amt"
                        type="number"
                        step="1"
                        required
                        value={creditAmount}
                        onChange={(e) => setCreditAmount(Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <FieldLabel htmlFor="adj-type">{locale === 'fa' ? 'نوع تراکنش' : 'Type'}</FieldLabel>
                      <Select
                        id="adj-type"
                        value={creditType}
                        onChange={(e) => setCreditType(e.target.value as typeof creditType)}
                      >
                        <option value="adjustment">{locale === 'fa' ? 'تنظیم دستی مدیر' : 'Manual Adjustment'}</option>
                        <option value="promotional_credit">{locale === 'fa' ? 'پاداش تبلیغاتی (با اعلان تلگرام)' : 'Promotional Reward'}</option>
                        <option value="grant">{locale === 'fa' ? 'اعطای اعتبار (Grant)' : 'Credit Grant'}</option>
                        <option value="refund">{locale === 'fa' ? 'جبران / استرداد اعتبار' : 'Credit Refund'}</option>
                      </Select>
                    </div>
                    <div>
                      <FieldLabel htmlFor="adj-reason" required>{locale === 'fa' ? 'دلیل (الزامی برای ممیزی)' : 'Audit Reason'}</FieldLabel>
                      <Input
                        id="adj-reason"
                        required
                        minLength={3}
                        value={creditReason}
                        onChange={(e) => setCreditReason(e.target.value)}
                        placeholder={locale === 'fa' ? 'جبران خطای ارائه‌دهنده...' : 'Compensation / promo...'}
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button type="submit" size="sm" disabled={actionBusy}>
                      {locale === 'fa' ? 'اعمال تغییر اعتبار' : 'Apply Credit Change'}
                    </Button>
                  </div>
                </form>

                {/* 2. Manual Plan Assignment */}
                <form
                  onSubmit={handleAssignPlan}
                  className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3"
                >
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {locale === 'fa' ? 'تخصیص یا ارتقای دستی پلن اشتراک' : 'Manual Plan Assignment / Upgrade'}
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <FieldLabel htmlFor="asgn-plan" required>{locale === 'fa' ? 'انتخاب پلن' : 'Select Plan'}</FieldLabel>
                      <Select id="asgn-plan" required value={planId} onChange={(e) => setPlanId(e.target.value)}>
                        <option value="">{locale === 'fa' ? 'انتخاب کنید...' : 'Select plan...'}</option>
                        {plans.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({formatNumber(p.durationDays, locale)}d)
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <FieldLabel htmlFor="asgn-days">{locale === 'fa' ? 'مدت سفارشی (روز · اختیاری)' : 'Custom Days (Optional)'}</FieldLabel>
                      <Input
                        id="asgn-days"
                        type="number"
                        min={1}
                        value={planDuration}
                        onChange={(e) => setPlanDuration(e.target.value)}
                        placeholder={locale === 'fa' ? 'پیش‌فرض پلن' : 'Plan default'}
                      />
                    </div>
                    <div>
                      <FieldLabel htmlFor="asgn-reason" required>{locale === 'fa' ? 'دلیل تخصیص' : 'Reason'}</FieldLabel>
                      <Input
                        id="asgn-reason"
                        required
                        minLength={3}
                        value={planReason}
                        onChange={(e) => setPlanReason(e.target.value)}
                        placeholder={locale === 'fa' ? 'حساب VIP / هدیه...' : 'VIP / comped access...'}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={planGrantCredits}
                        onChange={(e) => setPlanGrantCredits(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-300 text-blue-700"
                      />
                      <span>{locale === 'fa' ? 'اعتبار ماهانه پلن نیز به کیف‌پول اضافه شود' : 'Also grant plan monthly credit allocation'}</span>
                    </label>
                    <Button type="submit" size="sm" disabled={actionBusy || !planId}>
                      {locale === 'fa' ? 'تخصیص پلن' : 'Assign Plan'}
                    </Button>
                  </div>
                </form>

                {/* 3. Per-User Limit Overrides */}
                <form
                  onSubmit={handleSaveLimits}
                  className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3"
                >
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {locale === 'fa' ? 'محدودیت‌های سفارشی کاربر (Override · خالی = پیش‌فرض پلن)' : 'Per-User Quota Overrides (blank = plan default)'}
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    <div>
                      <FieldLabel htmlFor="lim-dr">{locale === 'fa' ? 'روزانه کل' : 'Daily Req'}</FieldLabel>
                      <Input id="lim-dr" type="number" min={0} value={limDailyReq} onChange={(e) => setLimDailyReq(e.target.value)} />
                    </div>
                    <div>
                      <FieldLabel htmlFor="lim-mr">{locale === 'fa' ? 'ماهانه کل' : 'Monthly Req'}</FieldLabel>
                      <Input id="lim-mr" type="number" min={0} value={limMonthlyReq} onChange={(e) => setLimMonthlyReq(e.target.value)} />
                    </div>
                    <div>
                      <FieldLabel htmlFor="lim-di">{locale === 'fa' ? 'تصویر روزانه' : 'Daily Img'}</FieldLabel>
                      <Input id="lim-di" type="number" min={0} value={limDailyImg} onChange={(e) => setLimDailyImg(e.target.value)} />
                    </div>
                    <div>
                      <FieldLabel htmlFor="lim-dv">{locale === 'fa' ? 'ویدیو روزانه' : 'Daily Vid'}</FieldLabel>
                      <Input id="lim-dv" type="number" min={0} value={limDailyVid} onChange={(e) => setLimDailyVid(e.target.value)} />
                    </div>
                    <div>
                      <FieldLabel htmlFor="lim-conc">{locale === 'fa' ? 'همزمانی' : 'Concurrent'}</FieldLabel>
                      <Input id="lim-conc" type="number" min={1} value={limConcurrent} onChange={(e) => setLimConcurrent(e.target.value)} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Input
                      value={limReason}
                      onChange={(e) => setLimReason(e.target.value)}
                      placeholder={locale === 'fa' ? 'یادداشت دلیل override...' : 'Override note...'}
                      className="max-w-sm"
                    />
                    <Button type="submit" size="sm" variant="outline" disabled={actionBusy}>
                      {locale === 'fa' ? 'ذخیره محدودیت‌ها' : 'Save Overrides'}
                    </Button>
                  </div>
                </form>

                {/* 4. Super Admin Permanent Data Deletion */}
                {adminRole === 'super_admin' && (
                  <div className="p-4 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50/40 dark:bg-red-950/20 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold text-red-800 dark:text-red-300">
                        {locale === 'fa' ? 'حذف دائم تمامی داده‌های کاربر (GDPR / انطباق)' : 'Permanent User Data Deletion (Super Admin)'}
                      </div>
                      <div className="text-[11px] text-red-700/80 dark:text-red-400 mt-0.5">
                        {locale === 'fa'
                          ? 'حساب کاربر و سوابق مرتبط به‌صورت برگشت‌ناپذیر حذف می‌شوند.'
                          : 'Permanently removes this user account and cascading relational data.'}
                      </div>
                    </div>
                    {!confirmDeleteOpen ? (
                      <Button variant="danger" size="sm" onClick={() => setConfirmDeleteOpen(true)}>
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>{locale === 'fa' ? 'حذف داده‌های کاربر' : 'Delete User Data'}</span>
                      </Button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => setConfirmDeleteOpen(false)}>
                          {t.common.cancel}
                        </Button>
                        <Button variant="danger" size="sm" disabled={actionBusy} onClick={handleDeleteUserData}>
                          {locale === 'fa' ? 'تایید حذف دائم' : 'Confirm Permanent Delete'}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {detailTab === 'billing' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold">
                    {locale === 'fa' ? 'پرداخت‌ها' : 'Payments'}
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-64 overflow-y-auto text-xs">
                    {detail.payments.length === 0 ? (
                      <div className="p-4 text-slate-500">{t.common.noData}</div>
                    ) : (
                      detail.payments.map((p) => (
                        <div key={p.id} className="p-3 flex items-center justify-between gap-2">
                          <div>
                            <div className="font-mono font-semibold">{p.orderNumber ?? p.id.slice(0, 8)}</div>
                            <div className="text-[11px] text-slate-500">{p.paymentType} · {formatDateTime(p.createdAt, locale)}</div>
                          </div>
                          <div className="text-end tabular-nums">
                            <div className="font-semibold">{formatNumber(p.amount, locale)} {p.currency}</div>
                            <StatusText tone={p.status === 'succeeded' ? 'success' : 'neutral'}>{p.status}</StatusText>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold">
                    {locale === 'fa' ? 'گردش کیف‌پول اعتبار' : 'Credit Ledger'}
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-64 overflow-y-auto text-xs">
                    {detail.creditTransactions.length === 0 ? (
                      <div className="p-4 text-slate-500">{t.common.noData}</div>
                    ) : (
                      detail.creditTransactions.map((c) => (
                        <div key={c.id} className="p-3 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium truncate">{c.description || c.type}</div>
                            <div className="text-[11px] text-slate-500 tabular-nums">
                              {formatNumber(c.balanceBefore, locale)} → {formatNumber(c.balanceAfter, locale)}
                            </div>
                          </div>
                          <div className={`font-semibold tabular-nums shrink-0 ${c.amount >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
                            {c.amount > 0 ? '+' : ''}{formatNumber(c.amount, locale)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {detailTab === 'activity' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold">
                    {locale === 'fa' ? 'تاریخچه اشتراک‌ها' : 'Subscriptions'}
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-64 overflow-y-auto text-xs">
                    {detail.subscriptions.length === 0 ? (
                      <div className="p-4 text-slate-500">{t.common.noData}</div>
                    ) : (
                      detail.subscriptions.map((s) => (
                        <div key={s.id} className="p-3 flex items-center justify-between gap-2">
                          <div>
                            <div className="font-semibold">{s.planName}</div>
                            <div className="text-[11px] text-slate-500">
                              {formatDateTime(s.startsAt, locale)} → {formatDateTime(s.endsAt, locale)}
                            </div>
                          </div>
                          <StatusText tone={s.status === 'active' ? 'success' : 'neutral'}>{s.status}</StatusText>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold">
                    {locale === 'fa' ? 'آخرین درخواست‌های AI' : 'Recent AI Requests'}
                  </div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-64 overflow-y-auto text-xs">
                    {detail.recentRequests.length === 0 ? (
                      <div className="p-4 text-slate-500">{t.common.noData}</div>
                    ) : (
                      detail.recentRequests.map((r) => (
                        <div key={r.id} className="p-3 flex items-center justify-between gap-2">
                          <div>
                            <div className="font-medium">{r.modelName || r.capability}</div>
                            <div className="text-[11px] text-slate-500">{formatDateTime(r.createdAt, locale)}</div>
                          </div>
                          <div className="text-end tabular-nums">
                            <div>-{formatNumber(r.creditsCharged, locale)} cr</div>
                            <StatusText tone={r.status === 'succeeded' ? 'success' : 'danger'}>{r.status}</StatusText>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
