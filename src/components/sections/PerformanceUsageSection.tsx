import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatNumber, type Locale } from '../../i18n';
import type { ModelCategory, ProviderType } from '../../shared/validation';
import { Button, EmptyState, StatusText, Surface, TableSkeleton } from '../ui/primitives';

interface ProviderPerfItem {
  id: string;
  name: string;
  providerType: ProviderType;
  connectionStatus: 'untested' | 'connected' | 'degraded' | 'failed';
  isActive: boolean;
  totalRequests: number;
  succeededRequests: number;
  failedRequests: number;
  fallbackRequests: number;
  successRate: number;
  avgLatencyMs: number;
  totalCostUsd: number;
}

interface ModelUsageItem {
  id: string;
  name: string;
  modelIdentifier: string;
  category: ModelCategory;
  isActive: boolean;
  creditCost: number;
  providerName: string;
  totalRequests: number;
  succeededRequests: number;
  failedRequests: number;
  successRate: number;
  avgLatencyMs: number;
  totalCredits: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export function ProviderPerformanceSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [items, setItems] = useState<ProviderPerfItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ providers: ProviderPerfItem[] }>(
        '/api/monitor/provider-performance',
      );
      setItems(res.providers);
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
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {t.nav.providerPerformance}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'نرخ موفقیت، میانگین زمان پاسخ (Latency)، تعداد Failover و هزینه کل هر ارائه‌دهنده هوش مصنوعی.'
              : 'Real-time success rate, average latency, failover counts, and spend per AI provider.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      {items.some((p) => p.avgLatencyMs > 0) && (
        <Surface className="p-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
            {locale === 'fa' ? 'مقایسه میانگین زمان پاسخ (میلی‌ثانیه)' : 'Average Latency by Provider (ms)'}
          </h2>
          <div className="h-56 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={items}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="avgLatencyMs" fill="#1d4ed8" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Surface>
      )}

      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={6} />
        ) : items.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'ارائه‌دهنده‌ای ثبت نشده است' : 'No providers registered'}
            description={
              locale === 'fa'
                ? 'پس از ثبت ارائه‌دهندگان و اجرای درخواست‌ها، معیارهای عملکردی در این بخش محاسبه می‌شوند.'
                : 'Provider performance telemetry appears here once providers are configured.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'ارائه‌دهنده' : 'Provider'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کل درخواست‌ها' : 'Total Requests'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'نرخ موفقیت' : 'Success Rate'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'میانگین تأخیر' : 'Avg Latency'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'هزینه کل (USD)' : 'Total Cost'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {items.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{p.name}</div>
                      <div className="text-[11px] text-slate-500">{t.providerTypes[p.providerType]}</div>
                    </td>
                    <td className="py-3.5 px-4 tabular-nums">
                      <div>{formatNumber(p.totalRequests, locale)}</div>
                      {p.fallbackRequests > 0 && (
                        <div className="text-[11px] text-amber-600">
                          {formatNumber(p.fallbackRequests, locale)} Failover
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 tabular-nums">
                      {p.totalRequests === 0 ? (
                        <StatusText tone="neutral">—</StatusText>
                      ) : (
                        <StatusText tone={p.successRate >= 95 ? 'success' : p.successRate >= 80 ? 'warning' : 'danger'}>
                          {formatNumber(p.successRate, locale)}%
                        </StatusText>
                      )}
                    </td>
                    <td className="py-3.5 px-4 tabular-nums">
                      {p.totalRequests === 0
                        ? '—'
                        : locale === 'fa'
                          ? `${formatNumber(p.avgLatencyMs, locale)} میلی‌ثانیه`
                          : `${formatNumber(p.avgLatencyMs, locale)} ms`}
                    </td>
                    <td className="py-3.5 px-4">
                      <span dir="ltr" className="inline-block font-mono">
                        ${p.totalCostUsd.toFixed(4)}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusText tone={p.isActive ? 'success' : 'neutral'}>
                        {p.isActive ? t.common.active : t.common.inactive}
                      </StatusText>
                    </td>
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

export function ModelUsageSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [items, setItems] = useState<ModelUsageItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ models: ModelUsageItem[] }>('/api/monitor/model-usage');
      setItems(res.models);
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
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.modelUsage}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'آمار تفکیکی مصرف مدل‌های هوش مصنوعی شامل تعداد درخواست، توکن ورودی/خروجی، اعتبار مصرفی و هزینه.'
              : 'Per-model usage breakdown including requests, token throughput, credit consumption, and USD spend.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      {items.some((m) => m.totalRequests > 0) && (
        <Surface className="p-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
            {locale === 'fa' ? 'تعداد درخواست‌ها به تفکیک مدل' : 'Total Requests by Model'}
          </h2>
          <div className="h-56 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={items}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="totalRequests" fill="#0f766e" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Surface>
      )}

      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={6} />
        ) : items.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'مدلی برای نمایش آمار یافت نشد' : 'No model usage data'}
            description={
              locale === 'fa'
                ? 'پس از ثبت مدل‌های هوش مصنوعی و دریافت درخواست از کاربران، گزارش مصرف هر مدل اینجا ثبت می‌شود.'
                : 'Model consumption statistics appear here once models are registered and used.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'مدل / ارائه‌دهنده' : 'Model / Provider'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'دسته‌بندی' : 'Category'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'درخواست / موفقیت' : 'Requests / Rate'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'توکن‌ها' : 'Tokens'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'اعتبار / هزینه' : 'Credits / Cost'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {items.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{m.name}</div>
                      <div className="text-[11px] text-slate-500">
                        {m.providerName} ·{' '}
                        <span dir="ltr" className="inline-block font-mono">
                          {m.modelIdentifier}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-slate-600 dark:text-slate-400">
                      {t.modelCategories[m.category]}
                    </td>
                    <td className="py-3.5 px-4 tabular-nums">
                      <div>{formatNumber(m.totalRequests, locale)}</div>
                      {m.totalRequests > 0 && (
                        <div className="text-[11px] text-emerald-700 dark:text-emerald-400">
                          {formatNumber(m.successRate, locale)}%
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 tabular-nums text-slate-600 dark:text-slate-400">
                      {formatNumber(m.inputTokens + m.outputTokens, locale)}
                    </td>
                    <td className="py-3.5 px-4 tabular-nums">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {formatNumber(Number(m.totalCredits.toFixed(2)), locale)}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        <span dir="ltr" className="inline-block font-mono">
                          ${m.totalCostUsd.toFixed(4)}
                        </span>
                      </div>
                    </td>
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
