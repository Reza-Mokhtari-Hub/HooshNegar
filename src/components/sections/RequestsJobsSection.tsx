import React, { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, RefreshCw, RotateCcw, XCircle } from 'lucide-react';
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
  errorCode?: string | null;
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

function formatDiagnosticLines(message: string): string {
  return message
    .replace(/^(Failed after \d+ key\/attempt\(s\):)\s*(#\d+)/, '$1\n$2')
    .replace(/\s+\|\s+/g, '\n');
}

function ErrorDiagnosticBox({
  errorCode,
  errorMessage,
  locale,
  defaultExpanded = false,
}: {
  errorCode?: string | null;
  errorMessage?: string | null;
  locale: Locale;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  if (!errorCode && !errorMessage) return null;

  const formatted = errorMessage ? formatDiagnosticLines(errorMessage) : '';
  const isLong = formatted.length > 90 || formatted.includes('\n');

  const handleCopy = async () => {
    const payload = [errorCode ? `[${errorCode}]` : '', formatted].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <div className="mt-1.5 space-y-1 max-w-md">
      <div className="flex flex-wrap items-center gap-2">
        {errorCode && (
          <span
            dir="ltr"
            className="inline-block font-mono text-[11px] font-semibold text-red-700 dark:text-red-400"
          >
            {errorCode}
          </span>
        )}
        {formatted && (
          <>
            {isLong && (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
              >
                {expanded ? (
                  <>
                    <ChevronUp className="w-3 h-3" />
                    <span>{locale === 'fa' ? 'بستن جزئیات' : 'Hide trace'}</span>
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3 h-3" />
                    <span>{locale === 'fa' ? 'جزئیات کامل خطا' : 'Full diagnostic trace'}</span>
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleCopy()}
              aria-label={locale === 'fa' ? 'کپی متن خطا' : 'Copy error diagnostic'}
              className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
              <span>{copied ? (locale === 'fa' ? 'کپی شد' : 'Copied') : locale === 'fa' ? 'کپی' : 'Copy'}</span>
            </button>
          </>
        )}
      </div>

      {formatted && !expanded && (
        <div
          dir="ltr"
          className="text-[11px] font-mono text-red-700 dark:text-red-300 line-clamp-2 break-all"
        >
          {formatted}
        </div>
      )}

      {formatted && expanded && (
        <pre
          dir="ltr"
          className="p-2.5 rounded-lg bg-slate-950 text-slate-100 border border-slate-800 text-[11px] font-mono whitespace-pre-wrap break-all select-all max-h-56 overflow-y-auto leading-relaxed"
        >
          {formatted}
        </pre>
      )}
    </div>
  );
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
              ? 'گزارش کامل درخواست‌های پردازش‌شده در موتور چندمدلی به همراه توکن، اعتبار، زمان پاسخ و لاگ Failover.'
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
                  <tr key={r.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 align-top">
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
                      {(r.errorCode || r.errorMessage) && (
                        <ErrorDiagnosticBox
                          errorCode={r.errorCode}
                          errorMessage={r.errorMessage}
                          locale={locale}
                        />
                      )}
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
              ? 'مدیریت صف پردازش‌های ناهمگام (تولید ویدیو، تصویر، صوت و گفتگو) با لاگ دقیق کلیدها، تلاش مجدد و لغو ایمن.'
              : 'Monitor async background generation jobs with per-key failure traces, retry, and safe refund cancellation.'}
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
                  <tr key={j.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 align-top">
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
                      {(j.errorCode || j.errorMessage) && (
                        <ErrorDiagnosticBox
                          errorCode={j.errorCode}
                          errorMessage={j.errorMessage}
                          locale={locale}
                        />
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
              ? 'بررسی دقیق خطای تک‌تک کلیدها و ارائه‌دهندگان (بدون نمایش کلید کامل) به همراه تأیید بازگشت خودکار اعتبار کاربران.'
              : 'Audit failed and canceled AI requests with redacted per-key traces and verified zero-charge credit refunds.'}
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
                ? 'در صورت بروز خطا از سمت ارائه‌دهندگان یا لغو توسط کاربر، جزئیات خطای هر کلید و تأییدیه بازگشت اعتبار در اینجا ثبت می‌شود.'
                : 'Failed or canceled AI requests will be logged here with sanitized per-key diagnostics.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کد خطا / لاگ کلیدها' : 'Error Code / Trace'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'مدل / ارائه‌دهنده' : 'Model / Provider'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'وضعیت اعتبار' : 'Credit Status'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'زمان' : 'Time'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {items.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 align-top">
                    <td className="py-3.5 px-4 max-w-lg">
                      <ErrorDiagnosticBox
                        errorCode={r.errorCode || 'PROVIDER_ERROR'}
                        errorMessage={r.errorMessage || '—'}
                        locale={locale}
                      />
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
