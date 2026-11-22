import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCcw, XCircle } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import type { CapabilityType } from '../../shared/validation';
import { Button, EmptyState, Select, StatusText, Surface, TableSkeleton } from '../ui/primitives';

interface AIRequestItem {
  id: string;
  capability: CapabilityType;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  inputTokens: number;
  outputTokens: number;
  creditsCharged: number;
  costUsd: number;
  latencyMs: number | null;
  promptPreview: string | null;
  retryCount: number;
  usedFallback: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  providerName: string | null;
  modelName: string | null;
  telegramUsername: string | null;
  displayName: string | null;
}

interface GenerationJobItem {
  id: string;
  requestId: string;
  capability: CapabilityType;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  progressPercent: number;
  attempts: number;
  maxAttempts: number;
  providerJobId: string | null;
  storageObjectKey: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  modelName: string | null;
  providerName: string | null;
  telegramUsername: string | null;
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'running' || status === 'queued') return 'warning';
  return 'neutral';
}

export function AIRequestsSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [requests, setRequests] = useState<AIRequestItem[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = statusFilter !== 'all' ? `?status=${encodeURIComponent(statusFilter)}` : '';
      const res = await apiRequest<{ requests: AIRequestItem[] }>(`/api/monitor/requests${qs}`);
      setRequests(res.requests);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.aiRequests}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'گزارش کامل درخواست‌های پردازش‌شده در موتور چندمدلی به همراه توکن، اعتبار، زمان پاسخ و Failover.'
              : 'Complete ledger of multi-provider AI requests with tokens, credits, latency, and failover telemetry.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-40">
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">{t.common.all}</option>
              <option value="succeeded">succeeded</option>
              <option value="running">running</option>
              <option value="queued">queued</option>
              <option value="failed">failed</option>
              <option value="canceled">canceled</option>
            </Select>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={5} cols={6} />
        ) : requests.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'درخواستی ثبت نشده است' : 'No AI requests recorded'}
            description={
              locale === 'fa'
                ? 'تمامی درخواست‌های متنی، تصویری، صوتی، ویدیویی و تحلیل سند کاربران پس از اجرا اینجا نمایش داده می‌شوند.'
                : 'Requests executed across text, image, audio, video, and document modalities appear here.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'قابلیت / پرامپت' : 'Capability / Prompt'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'مدل / ارائه‌دهنده' : 'Model / Provider'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'اعتبار / هزینه' : 'Credits / USD'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'تأخیر' : 'Latency'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'زمان' : 'Time'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {requests.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-4 max-w-xs">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {t.capabilities[r.capability] ?? r.capability}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate mt-0.5">
                        {r.promptPreview || '—'}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="text-slate-800 dark:text-slate-200">{r.modelName || '—'}</div>
                      <div className="text-[11px] text-slate-500">
                        {r.providerName || '—'}
                        {r.usedFallback && (
                          <span className="ms-1.5 text-amber-600 dark:text-amber-400">· Failover</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 tabular-nums">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {formatNumber(Number(r.creditsCharged.toFixed(2)), locale)}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        <span dir="ltr" className="inline-block font-mono">
                          ${r.costUsd.toFixed(4)}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4 tabular-nums text-slate-600 dark:text-slate-400">
                      {r.latencyMs !== null ? `${formatNumber(r.latencyMs, locale)} ms` : '—'}
                    </td>
                    <td className="py-3 px-4">
                      <StatusText tone={statusTone(r.status)}>{r.status}</StatusText>
                    </td>
                    <td className="py-3 px-4 text-slate-500 tabular-nums">
                      {formatDateTime(r.createdAt, locale)}
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

export function GenerationJobsSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [jobs, setJobs] = useState<GenerationJobItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ jobs: GenerationJobItem[] }>('/api/monitor/jobs');
      setJobs(res.jobs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRetry = async (jobId: string) => {
    await apiRequest(`/api/monitor/jobs/${jobId}/retry`, { method: 'POST' });
    setFeedback(locale === 'fa' ? 'کار مجدداً به صف پس‌زمینه ارسال شد.' : 'Job re-queued.');
    await load();
  };

  const handleCancel = async (jobId: string) => {
    await apiRequest(`/api/monitor/jobs/${jobId}/cancel`, { method: 'POST' });
    setFeedback(locale === 'fa' ? 'کار لغو و اعتبار کاربر بازگردانده شد.' : 'Job canceled and credits refunded.');
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.generationJobs}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'مدیریت صف پردازش‌های ناهمگام (تولید ویدیو، تصویر، صوت و گفتگو) با قابلیت تلاش مجدد و لغو ایمن.'
              : 'Monitor async background generation jobs with progress tracking, retry, and safe refund cancellation.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      {feedback && (
        <div className="p-3.5 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-800 dark:text-emerald-200">
          {feedback}
        </div>
      )}

      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={6} />
        ) : jobs.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'کاری در صف تولید وجود ندارد' : 'No generation jobs yet'}
            description={
              locale === 'fa'
                ? 'کارهای تولید هوش مصنوعی به صورت ناهمگام در این جدول ثبت و پیگیری می‌شوند.'
                : 'Asynchronous background generation jobs will appear here.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'قابلیت / مدل' : 'Capability / Model'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'پیشرفت' : 'Progress'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'تلاش‌ها' : 'Attempts'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'ایجاد' : 'Created'}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {jobs.map((j) => (
                  <tr key={j.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {t.capabilities[j.capability] ?? j.capability}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {j.modelName || '—'} · {j.providerName || '—'}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 w-44">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                          <div
                            className="h-full bg-blue-700 dark:bg-blue-500"
                            style={{ width: `${j.progressPercent}%` }}
                          />
                        </div>
                        <span className="tabular-nums text-[11px] text-slate-600 dark:text-slate-400">
                          {formatNumber(j.progressPercent, locale)}%
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 tabular-nums">
                      {formatNumber(j.attempts, locale)} / {formatNumber(j.maxAttempts, locale)}
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusText tone={statusTone(j.status)}>{j.status}</StatusText>
                      {j.errorMessage && (
                        <div className="text-[11px] text-red-600 truncate max-w-xs mt-0.5">
                          {j.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-slate-500 tabular-nums">
                      {formatDateTime(j.createdAt, locale)}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-end gap-1">
                        {j.status === 'failed' && (
                          <Button variant="outline" size="sm" onClick={() => void handleRetry(j.id)}>
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>{locale === 'fa' ? 'تلاش مجدد' : 'Retry'}</span>
                          </Button>
                        )}
                        {(j.status === 'queued' || j.status === 'running') && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleCancel(j.id)}
                            className="text-red-600"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            <span>{t.common.cancel}</span>
                          </Button>
                        )}
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

export function FailedRequestsSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [items, setItems] = useState<AIRequestItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ failedRequests: AIRequestItem[] }>('/api/monitor/failed-requests');
      setItems(res.failedRequests);
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
            {t.nav.failedRequests}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'بررسی خطاهای ارائه‌دهندگان و تأیید بازگشت خودکار اعتبار کاربران (هیچ هزینه‌ای برای درخواست‌های ناموفق کسر نمی‌شود).'
              : 'Audit failed and canceled AI requests with error codes and verified zero-charge credit refunds.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={5} />
        ) : items.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'هیچ درخواست ناموفقی وجود ندارد' : 'No failed requests'}
            description={
              locale === 'fa'
                ? 'در صورت بروز خطا از سمت ارائه‌دهندگان یا لغو توسط کاربر، جزئیات خطا و تأییدیه بازگشت اعتبار در اینجا ثبت می‌شود.'
                : 'Failed or canceled AI requests will be logged here with sanitized error diagnostics.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کد خطا / پیام' : 'Error Code / Message'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'مدل / ارائه‌دهنده' : 'Model / Provider'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'وضعیت اعتبار' : 'Credit Status'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'زمان' : 'Time'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {items.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4 max-w-md">
                      <span dir="ltr" className="inline-block font-mono font-semibold text-red-700 dark:text-red-400">
                        {r.errorCode || 'PROVIDER_ERROR'}
                      </span>
                      <div className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5 break-words">
                        {r.errorMessage || '—'}
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div>{r.modelName || '—'}</div>
                      <div className="text-[11px] text-slate-500">{r.providerName || '—'}</div>
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusText tone="success">
                        {r.creditsCharged === 0
                          ? locale === 'fa'
                            ? 'بازگشت کامل (۰ کسر)'
                            : 'Refunded (0 charged)'
                          : `${r.creditsCharged}`}
                      </StatusText>
                    </td>
                    <td className="py-3.5 px-4 text-slate-500 tabular-nums">
                      {formatDateTime(r.createdAt, locale)}
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
