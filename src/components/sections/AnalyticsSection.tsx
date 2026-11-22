import React, { useCallback, useEffect, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { RefreshCw } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatNumber, type Locale } from '../../i18n';
import type { CapabilityType } from '../../shared/validation';
import { Button, EmptyState, Surface } from '../ui/primitives';

interface AnalyticsData {
  summary: {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCredits: number;
    totalCostUsd: number;
  };
  byCapability: Array<{ capability: CapabilityType; requests: number; credits: number; costUsd: number }>;
  byDate: Array<{ date: string; requests: number; credits: number; costUsd: number }>;
}

export function AnalyticsSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<AnalyticsData>('/api/analytics');
      setData(res);
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
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.analytics}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'گزارش واقعی مصرف توکن، اعتبار و هزینه دلاری به تفکیک قابلیت از جداول ai_requests و usage_records.'
              : 'Live token, credit, and cost aggregations from ai_requests and usage_records.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Surface className="p-5">
            <div className="text-xs text-slate-500">{locale === 'fa' ? 'کل درخواست‌ها' : 'Total Requests'}</div>
            <div className={`text-2xl font-bold tabular-nums mt-2 text-slate-900 dark:text-slate-100 ${locale === 'en' ? 'font-mono' : ''}`}>
              {formatNumber(data.summary.totalRequests, locale)}
            </div>
          </Surface>
          <Surface className="p-5">
            <div className="text-xs text-slate-500">{locale === 'fa' ? 'توکن ورودی / خروجی' : 'Input / Output Tokens'}</div>
            <div className={`text-xl font-bold tabular-nums mt-2 text-slate-900 dark:text-slate-100 ${locale === 'en' ? 'font-mono' : ''}`}>
              {formatNumber(data.summary.totalInputTokens, locale)} / {formatNumber(data.summary.totalOutputTokens, locale)}
            </div>
          </Surface>
          <Surface className="p-5">
            <div className="text-xs text-slate-500">{locale === 'fa' ? 'مجموع اعتبار مصرفی' : 'Total Credits Charged'}</div>
            <div className={`text-2xl font-bold tabular-nums mt-2 text-slate-900 dark:text-slate-100 ${locale === 'en' ? 'font-mono' : ''}`}>
              {formatNumber(data.summary.totalCredits, locale)}
            </div>
          </Surface>
          <Surface className="p-5">
            <div className="text-xs text-slate-500">{locale === 'fa' ? 'هزینه کل ارائه‌دهندگان (USD)' : 'Provider Cost (USD)'}</div>
            <div className="text-2xl font-bold font-mono tabular-nums mt-2 text-slate-900 dark:text-slate-100">
              <span dir="ltr" className="inline-block">
                ${data.summary.totalCostUsd.toFixed(4)}
              </span>
            </div>
          </Surface>
        </div>
      )}

      <Surface className="p-6">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
          {locale === 'fa' ? 'تفکیک مصرف بر اساس قابلیت هوش مصنوعی' : 'Usage Breakdown by AI Capability'}
        </h2>
        {!data || data.byCapability.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'داده تحلیلی برای نمایش وجود ندارد' : 'No usage records available yet'}
            description={
              locale === 'fa'
                ? 'هیچ عدد ساختگی نمایش داده نمی‌شود. با شروع پردازش درخواست‌های واقعی در فاز ۲، نمودار تفکیک قابلیت‌ها تکمیل خواهد شد.'
                : 'No fabricated metrics are displayed. Breakdown charts populate automatically when real AI requests execute.'
            }
          />
        ) : (
          <div className="h-72" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.byCapability}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="capability" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="requests" fill="#1D4ED8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Surface>
    </div>
  );
}
