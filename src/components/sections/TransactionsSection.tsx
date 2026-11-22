import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import { Button, EmptyState, StatusText, Surface, TableSkeleton } from '../ui/primitives';

interface PaymentRow {
  id: string;
  userEmail: string | null;
  planName: string | null;
  gateway: string;
  gatewayRefId: string | null;
  amount: number;
  currency: string;
  status: string;
  idempotencyKey: string;
  createdAt: string;
}

interface CreditTxRow {
  id: string;
  userEmail: string | null;
  type: string;
  amount: number;
  balanceAfter: number;
  idempotencyKey: string;
  description: string;
  createdAt: string;
}

export function TransactionsSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [tab, setTab] = useState<'payments' | 'credits'>('payments');
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [credits, setCredits] = useState<CreditTxRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ payments: PaymentRow[]; creditTransactions: CreditTxRow[] }>(
        '/api/transactions',
      );
      setPayments(res.payments);
      setCredits(res.creditTransactions);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.transactions}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'دفتر کل پرداخت‌ها و تراکنش‌های کیف‌پول اعتبار با تضمین یکتایی Idempotency Key (درگاه پرداخت در فاز ۳).'
              : 'Idempotent payments and credit wallet ledger ready for Phase 3 gateway webhooks.'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setTab('payments')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                tab === 'payments'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {locale === 'fa' ? 'پرداخت‌های درگاه' : 'Gateway Payments'}
            </button>
            <button
              type="button"
              onClick={() => setTab('credits')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                tab === 'credits'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {locale === 'fa' ? 'دفتر کل اعتبار (Wallet)' : 'Credit Ledger'}
            </button>
          </div>

          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={5} />
        ) : tab === 'payments' ? (
          payments.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'هنوز پرداختی ثبت نشده است' : 'No payment records yet'}
              description={
                locale === 'fa'
                  ? 'جداول payments و payment_events با کلید idempotency_key در پایگاه‌داده ساخته شده‌اند و در فاز ۳ به درگاه پرداخت متصل می‌شوند.'
                  : 'Payments and payment_events tables with unique idempotency keys are migrated and ready for Phase 3.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کاربر / پلن' : 'User / Plan'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'مبلغ' : 'Amount'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'درگاه' : 'Gateway'}</th>
                    <th className="py-3 px-4 text-start">Idempotency Key</th>
                    <th className="py-3 px-4 text-start">{t.common.status}</th>
                    <th className="py-3 px-4 text-end">{t.common.createdAt}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td className="py-3.5 px-4">
                        <div className="font-medium text-slate-900 dark:text-slate-100">{p.userEmail ?? '—'}</div>
                        <div className="text-[11px] text-slate-500">{p.planName ?? '—'}</div>
                      </td>
                      <td className={`py-3.5 px-4 tabular-nums ${locale === 'en' ? 'font-mono' : ''}`}>
                        {formatNumber(p.amount, locale)} {p.currency}
                      </td>
                      <td className="py-3.5 px-4">{p.gateway}</td>
                      <td className="py-3.5 px-4 font-mono text-[11px] text-slate-500">
                        <span dir="ltr" className="inline-block">
                          {p.idempotencyKey}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <StatusText tone={p.status === 'succeeded' ? 'success' : 'warning'}>{p.status}</StatusText>
                      </td>
                      <td className="py-3.5 px-4 text-end text-slate-500">{formatDateTime(p.createdAt, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : credits.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'تراکنش اعتباری ثبت نشده است' : 'No credit ledger entries yet'}
            description={
              locale === 'fa'
                ? 'تمامی کسر اعتبار مصرف مدل‌ها، شارژ کیف‌پول و پاداش معرفی در جدول credit_transactions ثبت خواهد شد.'
                : 'Credit grants, debits, refunds, and referral bonuses will be logged here.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کاربر' : 'User'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'نوع تراکنش' : 'Type'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'تغییر اعتبار' : 'Delta'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'مانده پس از تراکنش' : 'Balance After'}</th>
                  <th className="py-3 px-4 text-end">{t.common.createdAt}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {credits.map((c) => (
                  <tr key={c.id}>
                    <td className="py-3.5 px-4">{c.userEmail ?? '—'}</td>
                    <td className="py-3.5 px-4 font-mono">
                      <span dir="ltr" className="inline-block">
                        {c.type}
                      </span>
                    </td>
                    <td className={`py-3.5 px-4 tabular-nums ${locale === 'en' ? 'font-mono' : ''}`}>
                      {formatNumber(c.amount, locale)}
                    </td>
                    <td className={`py-3.5 px-4 tabular-nums ${locale === 'en' ? 'font-mono' : ''}`}>
                      {formatNumber(c.balanceAfter, locale)}
                    </td>
                    <td className="py-3.5 px-4 text-end text-slate-500">{formatDateTime(c.createdAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>
    </div>
  );
}
