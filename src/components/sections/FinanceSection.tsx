import React, { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw, RotateCcw, Star } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import type { PlanRecord } from './PlansSection';
import type { ProviderRecord } from './ProvidersSection';
import type { ModelRecord } from './ModelsSection';
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
  Textarea,
} from '../ui/primitives';

interface FinanceSummaryResponse {
  kpis: {
    totalSuccessfulPayments: number;
    totalStarsXtr: number;
    subscriptionStarsXtr: number;
    creditPackageStarsXtr: number;
    estimatedRevenueUsd: number;
    starValueUsd: number;
    activePaidSubscriptions: number;
    freeUsers: number;
    conversionRatePct: number;
    renewalsCount: number;
    expiredSubscriptions: number;
    failedPayments: number;
    refundedPayments: number;
    refundedStarsXtr: number;
    purchasedCredits: number;
    subscriptionCredits: number;
    promotionalCredits: number;
    usageDebits: number;
    estimatedProviderCostUsd: number;
    estimatedGrossProfitUsd: number;
    estimatedMarginPct: number;
    totalSuccessfulAiRequests: number;
    isEstimatedCost: boolean;
  };
  payments: Array<{
    id: string;
    orderNumber: string | null;
    userId: string;
    userDisplayName: string | null;
    telegramUsername: string | null;
    planId: string | null;
    planName: string | null;
    creditPackageId: string | null;
    packageName: string | null;
    paymentType: string;
    gateway: string;
    telegramPaymentChargeId: string | null;
    amount: number;
    discountAmount: number;
    currency: string;
    status: string;
    isRecurring: boolean;
    refundStatus: string;
    refundReason: string;
    paidAt: string | null;
    createdAt: string;
  }>;
  creditLedger: Array<{
    id: string;
    userId: string;
    userDisplayName: string | null;
    type: string;
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
    description: string;
    createdAt: string;
  }>;
}

export function FinanceSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [data, setData] = useState<FinanceSummaryResponse | null>(null);
  const [plans, setPlans] = useState<PlanRecord[]>([]);
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'payments' | 'ledger'>('payments');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [planId, setPlanId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [status, setStatus] = useState('');

  const [refundTarget, setRefundTarget] = useState<FinanceSummaryResponse['payments'][number] | null>(null);
  const [refundReason, setRefundReason] = useState('');
  const [revokeBenefits, setRevokeBenefits] = useState(true);
  const [refunding, setRefunding] = useState(false);

  const buildQueryString = useCallback(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (planId) params.set('planId', planId);
    if (providerId) params.set('providerId', providerId);
    if (modelId) params.set('modelId', modelId);
    if (status) params.set('status', status);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [from, to, planId, providerId, modelId, status]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [finRes, plansRes, provRes, modRes] = await Promise.all([
        apiRequest<FinanceSummaryResponse>(`/api/finance/summary${buildQueryString()}`),
        apiRequest<{ plans: PlanRecord[] }>('/api/plans'),
        apiRequest<{ providers: ProviderRecord[] }>('/api/providers'),
        apiRequest<{ models: ModelRecord[] }>('/api/models'),
      ]);
      setData(finRes);
      setPlans(plansRes.plans);
      setProviders(provRes.providers);
      setModels(modRes.models);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در دریافت گزارش مالی' });
    } finally {
      setLoading(false);
    }
  }, [buildQueryString]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!refundTarget) return;
    setRefunding(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/finance/payments/${refundTarget.id}/refund`, {
        method: 'POST',
        body: { reason: refundReason.trim(), revokeBenefits },
      });
      setRefundTarget(null);
      setRefundReason('');
      setFeedback({
        tone: 'success',
        text:
          locale === 'fa'
            ? 'بازپرداخت رسمی تلگرام استارز (refundStarPayment) انجام و در دفترکل ثبت شد.'
            : 'Official Telegram Stars refund completed and recorded.',
      });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در بازپرداخت استارز' });
    } finally {
      setRefunding(false);
    }
  };

  const k = data?.kpis;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.finance}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'گزارش درآمد تلگرام استارز (XTR)، برآورد هزینه ارائه‌دهندگان هوش مصنوعی، حاشیه سود برآوردی، بازپرداخت رسمی و دفترکل اعتبار.'
              : 'Telegram Stars (XTR) revenue, estimated AI provider costs, estimated gross margin, official refunds, and auditable credit ledger.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/finance/export.csv${buildQueryString()}`}
            download="hooshnegar-finance-export.csv"
            className="inline-flex items-center justify-center h-8 px-3 text-xs gap-1.5 rounded-lg font-medium border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{locale === 'fa' ? 'خروجی CSV' : 'Export CSV'}</span>
          </a>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{t.common.refresh}</span>
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

      {/* Filter Toolbar */}
      <Surface className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <div>
            <FieldLabel htmlFor="fin-from">{locale === 'fa' ? 'از تاریخ' : 'From Date'}</FieldLabel>
            <Input id="fin-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <FieldLabel htmlFor="fin-to">{locale === 'fa' ? 'تا تاریخ' : 'To Date'}</FieldLabel>
            <Input id="fin-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <FieldLabel htmlFor="fin-plan">{locale === 'fa' ? 'پلن اشتراک' : 'Plan'}</FieldLabel>
            <Select id="fin-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">{t.common.all}</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor="fin-prov">{locale === 'fa' ? 'ارائه‌دهنده AI' : 'AI Provider'}</FieldLabel>
            <Select id="fin-prov" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">{t.common.all}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor="fin-model">{locale === 'fa' ? 'مدل AI' : 'AI Model'}</FieldLabel>
            <Select id="fin-model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
              <option value="">{t.common.all}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor="fin-status">{locale === 'fa' ? 'وضعیت پرداخت' : 'Payment Status'}</FieldLabel>
            <Select id="fin-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t.common.all}</option>
              <option value="succeeded">succeeded</option>
              <option value="pending">pending</option>
              <option value="failed">failed</option>
              <option value="refunded">refunded</option>
            </Select>
          </div>
        </div>
      </Surface>

      {/* Primary KPI Grid */}
      {k && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Surface className="p-4">
              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                {locale === 'fa' ? 'درآمد کل تلگرام استارز' : 'Total Stars Revenue'}
              </div>
              <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1.5 tabular-nums flex items-center gap-1.5">
                <span>{formatNumber(k.totalStarsXtr, locale)}</span>
                <Star className="w-5 h-5 text-amber-500 fill-amber-400 shrink-0" />
              </div>
              <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                {locale === 'fa'
                  ? `اشتراک ${formatNumber(k.subscriptionStarsXtr, locale)} · بسته اعتبار ${formatNumber(k.creditPackageStarsXtr, locale)}`
                  : `Subs ${k.subscriptionStarsXtr} · Packs ${k.creditPackageStarsXtr}`}
              </div>
            </Surface>

            <Surface className="p-4">
              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                {locale === 'fa' ? 'درآمد دلاری برآوردی (تخمینی)' : 'Est. Revenue (USD · Estimated)'}
              </div>
              <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1.5 tabular-nums font-mono">
                <span dir="ltr">${k.estimatedRevenueUsd.toFixed(2)}</span>
              </div>
              <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                {locale === 'fa'
                  ? `نرخ مرجع هر استارز: $${k.starValueUsd} · ${formatNumber(k.totalSuccessfulPayments, locale)} پرداخت موفق`
                  : `Rate: $${k.starValueUsd}/star · ${k.totalSuccessfulPayments} paid orders`}
              </div>
            </Surface>

            <Surface className="p-4">
              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                {locale === 'fa' ? 'هزینه ارائه‌دهندگان AI (برآوردی)' : 'Est. AI Provider Cost'}
              </div>
              <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1.5 tabular-nums font-mono">
                <span dir="ltr">${k.estimatedProviderCostUsd.toFixed(4)}</span>
              </div>
              <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                {locale === 'fa'
                  ? `${formatNumber(k.totalSuccessfulAiRequests, locale)} درخواست موفق AI`
                  : `${k.totalSuccessfulAiRequests} succeeded AI requests`}
              </div>
            </Surface>

            <Surface className="p-4">
              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                {locale === 'fa' ? 'سود ناخالص و حاشیه سود (برآوردی)' : 'Est. Gross Profit & Margin'}
              </div>
              <div
                className={`text-2xl font-bold mt-1.5 tabular-nums font-mono ${
                  k.estimatedGrossProfitUsd >= 0
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-red-700 dark:text-red-400'
                }`}
              >
                <span dir="ltr">${k.estimatedGrossProfitUsd.toFixed(2)}</span>
              </div>
              <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                {locale === 'fa'
                  ? `حاشیه سود برآوردی: ${k.estimatedMarginPct}%`
                  : `Estimated margin: ${k.estimatedMarginPct}%`}
              </div>
            </Surface>
          </div>

          {/* Secondary Operational Metrics */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Surface className="p-4">
              <div className="text-[11px] text-slate-500">
                {locale === 'fa' ? 'اشتراک پولی فعال / نرخ تبدیل' : 'Active Paid Subs / Conversion'}
              </div>
              <div className="text-lg font-bold text-slate-900 dark:text-slate-100 mt-1 tabular-nums">
                {formatNumber(k.activePaidSubscriptions, locale)}{' '}
                <span className="text-xs font-normal text-slate-500">({k.conversionRatePct}%)</span>
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                {locale === 'fa'
                  ? `کاربر رایگان: ${formatNumber(k.freeUsers, locale)} · منقضی: ${formatNumber(k.expiredSubscriptions, locale)}`
                  : `Free: ${k.freeUsers} · Expired: ${k.expiredSubscriptions}`}
              </div>
            </Surface>

            <Surface className="p-4">
              <div className="text-[11px] text-slate-500">
                {locale === 'fa' ? 'تمدیدها و بازپرداخت‌ها' : 'Renewals & Refunds'}
              </div>
              <div className="text-lg font-bold text-slate-900 dark:text-slate-100 mt-1 tabular-nums">
                {formatNumber(k.renewalsCount, locale)} / {formatNumber(k.refundedPayments, locale)}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                {locale === 'fa'
                  ? `استردادشده: ${formatNumber(k.refundedStarsXtr, locale)} استارز · ناموفق: ${formatNumber(k.failedPayments, locale)}`
                  : `Refunded: ${k.refundedStarsXtr} XTR · Failed: ${k.failedPayments}`}
              </div>
            </Surface>

            <Surface className="p-4">
              <div className="text-[11px] text-slate-500">
                {locale === 'fa' ? 'اعتبار صادره (خرید / اشتراک / هدیه)' : 'Credits Issued (Pack / Sub / Promo)'}
              </div>
              <div className="text-lg font-bold text-slate-900 dark:text-slate-100 mt-1 tabular-nums">
                {formatNumber(k.purchasedCredits + k.subscriptionCredits + k.promotionalCredits, locale)}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                {formatNumber(k.purchasedCredits, locale)} / {formatNumber(k.subscriptionCredits, locale)} /{' '}
                {formatNumber(k.promotionalCredits, locale)}
              </div>
            </Surface>

            <Surface className="p-4">
              <div className="text-[11px] text-slate-500">
                {locale === 'fa' ? 'اعتبار مصرف‌شده در AI' : 'Total AI Credits Debited'}
              </div>
              <div className="text-lg font-bold text-slate-900 dark:text-slate-100 mt-1 tabular-nums">
                {formatNumber(k.usageDebits, locale)}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {locale === 'fa' ? 'ثبت‌شده در دفترکل credit_transactions' : 'Audited in credit_transactions'}
              </div>
            </Surface>
          </div>
        </>
      )}

      {/* Tabs: Payments vs Credit Ledger */}
      <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setTab('payments')}
          className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
            tab === 'payments'
              ? 'border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-400'
              : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          {locale === 'fa' ? 'تراکنش‌های تلگرام استارز' : 'Telegram Stars Payments'}
        </button>
        <button
          type="button"
          onClick={() => setTab('ledger')}
          className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
            tab === 'ledger'
              ? 'border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-400'
              : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          {locale === 'fa' ? 'دفترکل حسابرسی اعتبار' : 'Auditable Credit Ledger'}
        </button>
      </div>

      {tab === 'payments' ? (
        <Surface className="overflow-hidden">
          {loading ? (
            <TableSkeleton rows={5} cols={6} />
          ) : !data || data.payments.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'پرداختی ثبت نشده است' : 'No payments recorded'}
              description={
                locale === 'fa'
                  ? 'پرداخت‌های تلگرام استارز (XTR) برای اشتراک‌ها و بسته‌های اعتبار پس از انجام در ربات اینجا نمایش داده می‌شوند.'
                  : 'Telegram Stars (XTR) subscription and credit pack transactions will appear here.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'سفارش / شناسه تلگرام' : 'Order / Charge ID'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کاربر' : 'User'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'آیتم و نوع' : 'Item & Type'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'مبلغ' : 'Amount'}</th>
                    <th className="py-3 px-4 text-start">{t.common.status}</th>
                    <th className="py-3 px-4 text-end">{t.common.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                  {data.payments.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                      <td className="py-3 px-4">
                        <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                          <span dir="ltr" className="inline-block">{p.orderNumber ?? p.id.slice(0, 8)}</span>
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 truncate max-w-[190px]">
                          <span dir="ltr" className="inline-block">{p.telegramPaymentChargeId ?? '—'}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-800 dark:text-slate-200">
                          {p.userDisplayName || p.userId.slice(0, 8)}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          <span dir="ltr" className="inline-block">
                            {p.telegramUsername ? `@${p.telegramUsername}` : formatDateTime(p.createdAt, locale)}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-800 dark:text-slate-200">
                          {p.planName || p.packageName || '—'}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {p.paymentType} {p.isRecurring ? '· recurring' : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4 tabular-nums">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {formatNumber(p.amount, locale)} {p.currency === 'XTR' ? '⭐️ XTR' : p.currency}
                        </div>
                        {p.discountAmount > 0 && (
                          <div className="text-[11px] text-emerald-700 dark:text-emerald-400">
                            -{formatNumber(p.discountAmount, locale)} {locale === 'fa' ? 'تخفیف' : 'discount'}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <StatusText
                          tone={
                            p.status === 'succeeded'
                              ? 'success'
                              : p.status === 'refunded'
                                ? 'warning'
                                : p.status === 'failed'
                                  ? 'danger'
                                  : 'neutral'
                          }
                        >
                          {p.status}
                        </StatusText>
                        {p.refundReason && (
                          <div className="text-[11px] text-slate-500 mt-0.5 max-w-[160px] truncate">
                            {p.refundReason}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-end">
                        {p.status === 'succeeded' && p.currency === 'XTR' && p.telegramPaymentChargeId ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setRefundTarget(p);
                              setRefundReason('');
                              setRevokeBenefits(true);
                            }}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>{locale === 'fa' ? 'بازپرداخت' : 'Refund'}</span>
                          </Button>
                        ) : (
                          <span className="text-[11px] text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Surface>
      ) : (
        <Surface className="overflow-hidden">
          {loading ? (
            <TableSkeleton rows={5} cols={5} />
          ) : !data || data.creditLedger.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'تراکنش اعتباری ثبت نشده است' : 'No credit ledger entries'}
              description={
                locale === 'fa'
                  ? 'تمامی تغییرات کیف‌پول اعتبار شامل خرید، مصرف AI، هدیه، معرفی و تنظیمات مدیریتی با موجودی قبل و بعد اینجا ثبت می‌شوند.'
                  : 'All wallet credits, AI usage debits, referrals, promos, and audited admin adjustments appear here.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کاربر' : 'User'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'نوع عملیات' : 'Type'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'تغییر اعتبار' : 'Delta'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'قبل ← بعد' : 'Before → After'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'شرح و زمان' : 'Description & Time'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                  {data.creditLedger.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                      <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">
                        {entry.userDisplayName || entry.userId.slice(0, 8)}
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                        <span dir="ltr" className="inline-block">{entry.type}</span>
                      </td>
                      <td
                        className={`py-3 px-4 tabular-nums font-semibold ${
                          entry.amount >= 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-red-700 dark:text-red-400'
                        }`}
                      >
                        {entry.amount > 0 ? '+' : ''}
                        {formatNumber(entry.amount, locale)}
                      </td>
                      <td className="py-3 px-4 tabular-nums text-slate-700 dark:text-slate-300">
                        {formatNumber(entry.balanceBefore, locale)} → {formatNumber(entry.balanceAfter, locale)}
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-700 dark:text-slate-300">{entry.description || '—'}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {formatDateTime(entry.createdAt, locale)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Surface>
      )}

      {/* Official Telegram Stars Refund Modal */}
      <Modal
        open={Boolean(refundTarget)}
        onClose={() => setRefundTarget(null)}
        maxWidth="max-w-md"
        title={locale === 'fa' ? 'بازپرداخت رسمی تلگرام استارز' : 'Refund Telegram Stars Payment'}
        description={
          refundTarget
            ? `${refundTarget.orderNumber ?? refundTarget.id.slice(0, 8)} · ${formatNumber(refundTarget.amount, locale)} ⭐️ XTR`
            : undefined
        }
      >
        <form onSubmit={handleRefund} className="space-y-4">
          <div>
            <FieldLabel htmlFor="refund-reason" required>
              {locale === 'fa' ? 'دلیل بازپرداخت (در گزارش ممیزی ثبت می‌شود)' : 'Refund Reason (Audit Logged)'}
            </FieldLabel>
            <Textarea
              id="refund-reason"
              rows={3}
              required
              minLength={3}
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              placeholder={locale === 'fa' ? 'درخواست کاربر از طریق /paysupport...' : 'User request via /paysupport...'}
            />
          </div>
          <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={revokeBenefits}
              onChange={(e) => setRevokeBenefits(e.target.checked)}
              className="w-4 h-4 mt-0.5 rounded border-slate-300 text-red-600"
            />
            <span>
              {locale === 'fa'
                ? 'لغو اشتراک مرتبط یا کسر اعتبار تخصیص‌یافته پس از بازپرداخت'
                : 'Revoke granted subscription / claw back granted credits upon refund'}
            </span>
          </label>
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <Button variant="outline" onClick={() => setRefundTarget(null)}>{t.common.cancel}</Button>
            <Button type="submit" variant="danger" disabled={refunding}>
              {refunding
                ? locale === 'fa'
                  ? 'در حال بازپرداخت...'
                  : 'Refunding...'
                : locale === 'fa'
                  ? 'تایید و اجرای refundStarPayment'
                  : 'Confirm Stars Refund'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
