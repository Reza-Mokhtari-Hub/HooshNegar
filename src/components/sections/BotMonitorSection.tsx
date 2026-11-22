import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Radio, Play } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import { Button, EmptyState, Input, StatusText, Surface, TableSkeleton } from '../ui/primitives';

interface BotMonitorResponse {
  bot: {
    botUsername: string;
    botDisplayName: string;
    webhookUrl: string;
    isActive: boolean;
    connectionStatus: 'untested' | 'connected' | 'degraded' | 'failed';
    lastTestedAt: string | null;
    lastTestMessage: string | null;
    hasBotToken: boolean;
    hasWebhookSecret: boolean;
  } | null;
  summary: {
    connectedTelegramUsers: number;
    totalConversations: number;
    activeJobs: number;
    storedMediaFiles: number;
    totalWebhookEvents: number;
    failedWebhookEvents: number;
  };
  infrastructure: {
    qstashConfigured: boolean;
    r2Configured: boolean;
    aiMockMode: boolean;
    databaseMode: string;
  };
  recentEvents: Array<{
    id: string;
    externalEventId: string;
    eventType: string;
    signatureVerified: boolean;
    status: string;
    errorMessage: string | null;
    receivedAt: string;
    processedAt: string | null;
  }>;
}

export function BotMonitorSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [data, setData] = useState<BotMonitorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [simPrompt, setSimPrompt] = useState('یک خلاصه کوتاه از قابلیت‌های هوش مصنوعی بنویس.');
  const [simRunning, setSimRunning] = useState(false);
  const [simResult, setSimResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<BotMonitorResponse>('/api/monitor/bot');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در بارگذاری وضعیت پایش ربات');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSimulate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSimRunning(true);
    setSimResult(null);
    setError(null);
    try {
      const res = await apiRequest<{
        ok: boolean;
        status: string;
        responseText?: string;
      }>('/api/monitor/bot/simulate', {
        method: 'POST',
        body: {
          telegramUserId: 700101,
          username: 'hooshnegar_tester',
          firstName: 'آرش رضایی',
          prompt: simPrompt,
          capability: 'chat',
        },
      });
      setSimResult(
        res.responseText
          ? `${locale === 'fa' ? 'پاسخ ثبت‌شده: ' : 'Response: '}${res.responseText.slice(0, 180)}`
          : `Status: ${res.status}`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در شبیه‌سازی');
    } finally {
      setSimRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.botMonitor}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'پایش زنده وضعیت وب‌هوک تلگرام، صف پردازش پس‌زمینه (QStash)، ذخیره‌سازی رسانه (R2) و رویدادهای دریافتی.'
              : 'Live monitoring of Telegram webhooks, Upstash QStash job queue, Cloudflare R2 storage, and recent update events.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      {error && (
        <div className="p-3.5 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          {
            label: locale === 'fa' ? 'کاربران متصل تلگرام' : 'Connected TG Users',
            value: data?.summary.connectedTelegramUsers ?? 0,
          },
          {
            label: locale === 'fa' ? 'گفتگوهای ثبت‌شده' : 'Total Conversations',
            value: data?.summary.totalConversations ?? 0,
          },
          {
            label: locale === 'fa' ? 'کارهای فعال در صف' : 'Active Queued Jobs',
            value: data?.summary.activeJobs ?? 0,
          },
          {
            label: locale === 'fa' ? 'رویدادهای وب‌هوک' : 'Webhook Events',
            value: data?.summary.totalWebhookEvents ?? 0,
          },
        ].map((kpi) => (
          <Surface key={kpi.label} className="p-4">
            <div className="text-xs text-slate-500 dark:text-slate-400">{kpi.label}</div>
            <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-2 tabular-nums">
              {formatNumber(kpi.value, locale)}
            </div>
          </Surface>
        ))}
      </div>

      {/* Infrastructure Readiness */}
      <Surface className="p-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
          <Radio className="w-4 h-4 text-blue-700 dark:text-blue-400" />
          <span>{locale === 'fa' ? 'آمادگی زیرساخت فاز ۲' : 'Phase 2 Infrastructure Readiness'}</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
            <div className="text-slate-500">{locale === 'fa' ? 'وضعیت ربات تلگرام' : 'Telegram Bot'}</div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <StatusText tone={data?.bot?.isActive ? 'success' : 'warning'}>
                {data?.bot?.isActive
                  ? locale === 'fa'
                    ? 'فعال'
                    : 'Active'
                  : locale === 'fa'
                    ? 'غیرفعال'
                    : 'Inactive'}
              </StatusText>
              {data?.bot?.botUsername && (
                <span dir="ltr" className="inline-block font-mono text-[11px] text-slate-500">
                  @{data.bot.botUsername}
                </span>
              )}
            </div>
          </div>

          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
            <div className="text-slate-500">{locale === 'fa' ? 'صف پایدار Upstash QStash' : 'Upstash QStash'}</div>
            <div className="mt-1.5">
              <StatusText tone={data?.infrastructure.qstashConfigured ? 'success' : 'neutral'}>
                {data?.infrastructure.qstashConfigured
                  ? locale === 'fa'
                    ? 'متصل (تأیید امضا فعال)'
                    : 'Connected (Signed)'
                  : locale === 'fa'
                    ? 'صف محلی ناهمگام (توسعه)'
                    : 'Local Async Queue (Dev)'}
              </StatusText>
            </div>
          </div>

          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
            <div className="text-slate-500">{locale === 'fa' ? 'فضای رسانه Cloudflare R2' : 'Cloudflare R2 Storage'}</div>
            <div className="mt-1.5">
              <StatusText tone={data?.infrastructure.r2Configured ? 'success' : 'neutral'}>
                {data?.infrastructure.r2Configured
                  ? locale === 'fa'
                    ? 'متصل (لینک امضاشده)'
                    : 'Connected (Signed URLs)'
                  : locale === 'fa'
                    ? 'ذخیره موقت محلی'
                    : 'Local Temp Fallback'}
              </StatusText>
            </div>
          </div>

          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
            <div className="text-slate-500">{locale === 'fa' ? 'راز احراز هویت وب‌هوک' : 'Webhook Secret Token'}</div>
            <div className="mt-1.5">
              <StatusText tone={data?.bot?.hasWebhookSecret ? 'success' : 'warning'}>
                {data?.bot?.hasWebhookSecret
                  ? locale === 'fa'
                    ? 'رمزنگاری‌شده و فعال'
                    : 'Encrypted & Active'
                  : locale === 'fa'
                    ? 'تنظیم نشده'
                    : 'Not Configured'}
              </StatusText>
            </div>
          </div>
        </div>
      </Surface>

      {/* Dev-only Mock Simulation Trigger (Only rendered when AI_MOCK_MODE=true) */}
      {data?.infrastructure.aiMockMode && (
        <Surface className="p-5 border-amber-200 dark:border-amber-900/60">
          <div className="text-xs font-semibold text-amber-800 dark:text-amber-300 mb-2">
            {locale === 'fa'
              ? 'حالت توسعه فعال است (AI_MOCK_MODE=true) — تست چرخه کامل ربات'
              : 'Dev Mock Mode Active (AI_MOCK_MODE=true) — End-to-End Pipeline Test'}
          </div>
          <form onSubmit={handleSimulate} className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[220px]">
              <Input
                value={simPrompt}
                onChange={(e) => setSimPrompt(e.target.value)}
                placeholder={locale === 'fa' ? 'متن پیام آزمایشی کاربر تلگرام...' : 'Test Telegram message...'}
              />
            </div>
            <Button type="submit" size="sm" disabled={simRunning}>
              <Play className="w-3.5 h-3.5" />
              <span>{simRunning ? t.common.testing : locale === 'fa' ? 'اجرای تست چرخه' : 'Run Test Flow'}</span>
            </Button>
          </form>
          {simResult && (
            <div className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">{simResult}</div>
          )}
        </Surface>
      )}

      {/* Recent Webhook Events */}
      <Surface className="overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {locale === 'fa' ? 'آخرین رویدادهای وب‌هوک تلگرام (Idempotency Log)' : 'Recent Telegram Webhook Events'}
          </h2>
          <span className="text-xs text-slate-500 tabular-nums">
            {formatNumber(data?.summary.failedWebhookEvents ?? 0, locale)}{' '}
            {locale === 'fa' ? 'خطا' : 'failed'}
          </span>
        </div>

        {loading ? (
          <TableSkeleton rows={4} cols={5} />
        ) : !data || data.recentEvents.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'هنوز رویداد وب‌هوکی دریافت نشده است' : 'No webhook events received yet'}
            description={
              locale === 'fa'
                ? 'پس از تنظیم توکن ربات و ثبت وب‌هوک از بخش تنظیمات تلگرام، تمام آپدیت‌های دریافتی به همراه وضعیت احراز امضا در اینجا ثبت می‌شوند.'
                : 'Once the Telegram webhook is registered, incoming updates and their idempotency states appear here.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'شناسه آپدیت' : 'Update ID'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'نوع رویداد' : 'Event Type'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'احراز امضا' : 'Signature'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'زمان دریافت' : 'Received'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {data.recentEvents.map((ev) => (
                  <tr key={ev.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-4">
                      <span dir="ltr" className="inline-block font-mono text-slate-800 dark:text-slate-200">
                        {ev.externalEventId}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span dir="ltr" className="inline-block font-mono text-slate-600 dark:text-slate-400">
                        {ev.eventType}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <StatusText tone={ev.signatureVerified ? 'success' : 'danger'}>
                        {ev.signatureVerified ? t.common.yes : t.common.no}
                      </StatusText>
                    </td>
                    <td className="py-3 px-4">
                      <StatusText
                        tone={
                          ev.status === 'processed'
                            ? 'success'
                            : ev.status === 'failed'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {ev.status}
                      </StatusText>
                      {ev.errorMessage && (
                        <div className="text-[11px] text-red-600 mt-0.5 truncate max-w-xs">
                          {ev.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-500 tabular-nums">
                      {formatDateTime(ev.receivedAt, locale)}
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
