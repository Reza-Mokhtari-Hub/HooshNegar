import React, { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Play,
  ShieldCheck,
  Square,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatNumber, type Locale } from '../../i18n';
import { MODEL_CATEGORIES, type ModelCategory } from '../../shared/validation';
import type { ProviderRecord } from './ProvidersSection';
import { Button, FieldLabel, Modal, Select } from '../ui/primitives';

export type HealthPruneAction = 'report_only' | 'deactivate_broken' | 'delete_broken';
export type ModelHealthStatus =
  | 'healthy'
  | 'rate_limited'
  | 'broken'
  | 'auth_error'
  | 'transient';

interface ModelHealthProbeResult {
  modelId: string;
  modelName: string;
  modelIdentifier: string;
  providerId: string;
  providerName: string;
  category: ModelCategory;
  status: ModelHealthStatus;
  preserved: boolean;
  httpStatus: number | null;
  reasonFa: string;
  technicalReason: string;
  latencyMs: number;
  actionTaken: 'kept' | 'deactivated' | 'deleted';
}

interface BatchModelHealthResponse {
  totalMatching: number;
  offset: number;
  limit: number;
  processedCount: number;
  nextOffset: number | null;
  hasMore: boolean;
  action: HealthPruneAction;
  summary: {
    healthy: number;
    rateLimited: number;
    broken: number;
    authError: number;
    transient: number;
    deactivated: number;
    deleted: number;
    kept: number;
  };
  results: ModelHealthProbeResult[];
}

export function ModelHealthPrunerModal({
  open,
  onClose,
  locale,
  providers,
  modelCountsByProvider,
  onCompleted,
}: {
  open: boolean;
  onClose: () => void;
  locale: Locale;
  providers: ProviderRecord[];
  modelCountsByProvider: Record<string, number>;
  onCompleted: () => Promise<void> | void;
}) {
  const t = DICTIONARIES[locale];
  const isFa = locale === 'fa';

  const [selectedProviderId, setSelectedProviderId] = useState<string>('all');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [action, setAction] = useState<HealthPruneAction>('deactivate_broken');
  const [onlyActive, setOnlyActive] = useState(true);

  const [running, setRunning] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [totalTarget, setTotalTarget] = useState(0);
  const [processedTotal, setProcessedTotal] = useState(0);
  const [results, setResults] = useState<ModelHealthProbeResult[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | 'broken' | 'rate_limited' | 'healthy'>('all');
  const [finished, setFinished] = useState(false);

  const cancelRef = useRef(false);

  const counts = useMemo(() => {
    let healthy = 0;
    let rateLimited = 0;
    let broken = 0;
    let pruned = 0;
    for (const r of results) {
      if (r.status === 'healthy') healthy += 1;
      else if (r.status === 'broken') broken += 1;
      else rateLimited += 1; // rate_limited + transient + auth_error (all preserved)
      if (r.actionTaken === 'deactivated' || r.actionTaken === 'deleted') pruned += 1;
    }
    return { healthy, rateLimited, broken, pruned };
  }, [results]);

  const filteredResults = useMemo(() => {
    if (statusFilter === 'all') return results;
    if (statusFilter === 'rate_limited') {
      return results.filter(
        (r) => r.status === 'rate_limited' || r.status === 'transient' || r.status === 'auth_error',
      );
    }
    return results.filter((r) => r.status === statusFilter);
  }, [results, statusFilter]);

  const handleStartScan = async () => {
    cancelRef.current = false;
    setRunning(true);
    setFinished(false);
    setErrorText(null);
    setResults([]);
    setTotalTarget(0);
    setProcessedTotal(0);

    let offset = 0;
    let initialTotal = 0;
    let hasMore = true;
    let accumulatedProcessed = 0;
    let changedAnything = false;

    try {
      while (hasMore && !cancelRef.current) {
        const payload: Record<string, unknown> = {
          onlyActive,
          offset,
          limit: 8,
          action,
        };
        if (selectedProviderId !== 'all') payload.providerId = selectedProviderId;
        if (selectedCategory !== 'all') payload.category = selectedCategory;

        const batch = await apiRequest<BatchModelHealthResponse>('/api/models/health-check', {
          method: 'POST',
          body: payload,
        });

        if (initialTotal === 0) {
          initialTotal = batch.totalMatching;
          setTotalTarget(batch.totalMatching);
        }

        if (batch.results.length > 0) {
          setResults((prev) => {
            const seen = new Set(prev.map((item) => item.modelId));
            const fresh = batch.results.filter((item) => !seen.has(item.modelId));
            return fresh.length > 0 ? [...prev, ...fresh] : prev;
          });
          accumulatedProcessed += batch.results.length;
          setProcessedTotal(accumulatedProcessed);
          if (batch.summary.deactivated > 0 || batch.summary.deleted > 0) {
            changedAnything = true;
          }
        }

        hasMore = batch.hasMore && batch.nextOffset !== null && batch.results.length > 0;
        offset = batch.nextOffset ?? offset + batch.results.length;
      }

      setFinished(true);
      if (changedAnything) {
        await onCompleted();
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'خطا در بررسی سلامت مدل‌ها');
    } finally {
      setRunning(false);
    }
  };

  const handleStop = () => {
    cancelRef.current = true;
  };

  const handleClose = () => {
    if (running) {
      cancelRef.current = true;
    }
    onClose();
  };

  const progressPct =
    totalTarget > 0 ? Math.min(100, Math.round((processedTotal / totalTarget) * 100)) : 0;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      maxWidth="max-w-4xl"
      title={isFa ? 'پالایش هوشمند مدل‌های سالم' : 'Smart Model Health Check & Pruner'}
      description={
        isFa
          ? 'تست زنده مدل‌های واردشده در دسته‌های کوچک برای حفظ مدل‌های سالم و لیمیت‌دار، و پالایش فقط مدل‌های واقعاً خراب.'
          : 'Live batched probe that preserves working and rate-limited models while pruning only permanently broken ones.'
      }
    >
      <div className="space-y-4">
        {/* Guarantee Banner */}
        <div className="p-3.5 rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/30 flex items-start gap-2.5 text-xs text-emerald-900 dark:text-emerald-200">
          <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
          <div className="leading-relaxed">
            <strong className="font-semibold">
              {isFa ? 'تضمین حفظ مدل‌های لیمیت‌دار:' : 'Rate-Limit Preservation Guarantee:'}
            </strong>{' '}
            {isFa
              ? 'مدل‌هایی که فقط Rate Limit موقت (429)، شلوغی سرور (5xx)، تایم‌اوت یا خطای کلید API دارند هرگز حذف یا غیرفعال نمی‌شوند. فقط مدل‌های واقعاً خراب (404، سهمیه صفر limit:0، نیازمند Billing 403، پولی 402 یا تابع UI خراب) پالایش می‌شوند.'
              : 'Models returning temporary 429 rate limits, 5xx errors, timeouts, or 401 auth errors are ALWAYS kept. Only permanently broken models (404, limit:0, 403 billing/gated, 402 paid-only, broken UI helpers) are pruned.'}
          </div>
        </div>

        {/* Filters & Mode */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <FieldLabel htmlFor="prune-provider">
              {isFa ? 'ارائه‌دهنده هدف' : 'Target Provider'}
            </FieldLabel>
            <Select
              id="prune-provider"
              disabled={running}
              value={selectedProviderId}
              onChange={(e) => setSelectedProviderId(e.target.value)}
            >
              <option value="all">{isFa ? 'همه ارائه‌دهندگان' : 'All Providers'}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({formatNumber(modelCountsByProvider[p.id] ?? 0, locale)}{' '}
                  {isFa ? 'مدل' : 'models'})
                </option>
              ))}
            </Select>
          </div>

          <div>
            <FieldLabel htmlFor="prune-category">
              {isFa ? 'دسته‌بندی مدل' : 'Model Category'}
            </FieldLabel>
            <Select
              id="prune-category"
              disabled={running}
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
            >
              <option value="all">{isFa ? 'همه دسته‌بندی‌ها' : 'All Categories'}</option>
              {MODEL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t.modelCategories[c]}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <FieldLabel htmlFor="prune-action">
              {isFa ? 'نحوه برخورد با مدل‌های خراب' : 'Action on Broken Models'}
            </FieldLabel>
            <Select
              id="prune-action"
              disabled={running}
              value={action}
              onChange={(e) => setAction(e.target.value as HealthPruneAction)}
            >
              <option value="deactivate_broken">
                {isFa ? 'غیرفعال‌سازی خراب‌ها (پیشنهادی)' : 'Deactivate broken (Recommended)'}
              </option>
              <option value="delete_broken">
                {isFa ? 'حذف کامل خراب‌ها (حفظ لیمیت‌دارها)' : 'Delete broken (Keep rate-limited)'}
              </option>
              <option value="report_only">
                {isFa ? 'فقط تست و گزارش (بدون تغییر)' : 'Report only (Dry run)'}
              </option>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              disabled={running}
              checked={onlyActive}
              onChange={(e) => setOnlyActive(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-blue-700"
            />
            <span>{isFa ? 'فقط مدل‌های فعال فعلی بررسی شوند' : 'Check currently active models only'}</span>
          </label>

          <div className="flex items-center gap-2">
            {running ? (
              <Button variant="danger" size="sm" onClick={handleStop}>
                <Square className="w-3.5 h-3.5" />
                <span>{isFa ? 'توقف بررسی' : 'Stop Scan'}</span>
              </Button>
            ) : (
              <Button size="sm" onClick={handleStartScan}>
                <Play className="w-3.5 h-3.5" />
                <span>{isFa ? 'شروع پالایش هوشمند' : 'Start Smart Health Check'}</span>
              </Button>
            )}
          </div>
        </div>

        {errorText && (
          <div className="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
            {errorText}
          </div>
        )}

        {/* Progress Bar */}
        {(running || finished || results.length > 0) && (
          <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
              <span>
                {running
                  ? isFa
                    ? `در حال تست زنده... (${formatNumber(processedTotal, locale)} از ${formatNumber(totalTarget, locale)} مدل)`
                    : `Probing live models... (${processedTotal} / ${totalTarget})`
                  : isFa
                    ? `بررسی تکمیل شد: ${formatNumber(processedTotal, locale)} مدل ارزیابی شد`
                    : `Completed: ${processedTotal} models checked`}
              </span>
              <span className="font-mono font-semibold">{progressPct}%</span>
            </div>
            <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>

            {/* Live Counters */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div className="p-3 rounded-lg border border-emerald-200/80 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20">
                <div className="text-[11px] text-emerald-700 dark:text-emerald-400">
                  {isFa ? 'سالم (حفظ شد)' : 'Healthy (Kept)'}
                </div>
                <div className="text-lg font-bold text-emerald-800 dark:text-emerald-200 mt-0.5">
                  {formatNumber(counts.healthy, locale)}
                </div>
              </div>
              <div className="p-3 rounded-lg border border-amber-200/80 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/20">
                <div className="text-[11px] text-amber-700 dark:text-amber-400">
                  {isFa ? 'لیمیت‌دار / موقت (حفظ شد)' : 'Rate-Limited (Kept)'}
                </div>
                <div className="text-lg font-bold text-amber-800 dark:text-amber-200 mt-0.5">
                  {formatNumber(counts.rateLimited, locale)}
                </div>
              </div>
              <div className="p-3 rounded-lg border border-red-200/80 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/20">
                <div className="text-[11px] text-red-700 dark:text-red-400">
                  {isFa ? 'واقعاً خراب' : 'Genuinely Broken'}
                </div>
                <div className="text-lg font-bold text-red-800 dark:text-red-200 mt-0.5">
                  {formatNumber(counts.broken, locale)}
                </div>
              </div>
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60">
                <div className="text-[11px] text-slate-600 dark:text-slate-400">
                  {isFa ? 'پالایش‌شده (حذف/غیرفعال)' : 'Pruned'}
                </div>
                <div className="text-lg font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                  {formatNumber(counts.pruned, locale)}
                </div>
              </div>
            </div>

            {/* Result filter tabs */}
            {results.length > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      ['all', isFa ? `همه (${formatNumber(results.length, locale)})` : `All (${results.length})`],
                      ['broken', isFa ? `خراب (${formatNumber(counts.broken, locale)})` : `Broken (${counts.broken})`],
                      [
                        'rate_limited',
                        isFa
                          ? `لیمیت‌دار/حفظ‌شده (${formatNumber(counts.rateLimited, locale)})`
                          : `Rate-Limited (${counts.rateLimited})`,
                      ],
                      ['healthy', isFa ? `سالم (${formatNumber(counts.healthy, locale)})` : `Healthy (${counts.healthy})`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setStatusFilter(key)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                        statusFilter === key
                          ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Results Table */}
                <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-start border-collapse text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-900/80 sticky top-0 border-b border-slate-200 dark:border-slate-800">
                      <tr>
                        <th className="py-2 px-3 text-start font-medium text-slate-600 dark:text-slate-400">
                          {isFa ? 'مدل' : 'Model'}
                        </th>
                        <th className="py-2 px-3 text-start font-medium text-slate-600 dark:text-slate-400">
                          {isFa ? 'وضعیت' : 'Status'}
                        </th>
                        <th className="py-2 px-3 text-start font-medium text-slate-600 dark:text-slate-400">
                          {isFa ? 'نتیجه بررسی' : 'Diagnosis'}
                        </th>
                        <th className="py-2 px-3 text-start font-medium text-slate-600 dark:text-slate-400">
                          {isFa ? 'اقدام' : 'Action'}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                      {filteredResults.map((row) => (
                        <tr key={row.modelId} className="hover:bg-slate-50/70 dark:hover:bg-slate-900/40">
                          <td className="py-2 px-3">
                            <div className="font-medium text-slate-900 dark:text-slate-100">
                              {row.modelName}
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono truncate max-w-[210px]" dir="ltr">
                              {row.modelIdentifier}
                            </div>
                          </td>
                          <td className="py-2 px-3 whitespace-nowrap">
                            {row.status === 'healthy' ? (
                              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                {isFa ? 'سالم' : 'Healthy'}
                              </span>
                            ) : row.status === 'broken' ? (
                              <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400 font-medium">
                                <XCircle className="w-3.5 h-3.5" />
                                {isFa ? 'خراب' : 'Broken'}
                              </span>
                            ) : row.status === 'rate_limited' ? (
                              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
                                <Clock className="w-3.5 h-3.5" />
                                {isFa ? 'لیمیت موقت' : 'Rate Limit'}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 font-medium">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                {row.status === 'auth_error'
                                  ? isFa
                                    ? 'خطای کلید'
                                    : 'Auth Err'
                                  : isFa
                                    ? 'خطای موقت'
                                    : 'Transient'}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-slate-700 dark:text-slate-300 max-w-xs">
                            <div>{row.reasonFa}</div>
                            <div className="text-[10px] text-slate-400 font-mono truncate" dir="ltr">
                              {row.latencyMs}ms · {row.technicalReason}
                            </div>
                          </td>
                          <td className="py-2 px-3 whitespace-nowrap">
                            {row.actionTaken === 'deleted' ? (
                              <span className="text-red-700 dark:text-red-400 font-semibold">
                                {isFa ? 'حذف شد' : 'Deleted'}
                              </span>
                            ) : row.actionTaken === 'deactivated' ? (
                              <span className="text-amber-700 dark:text-amber-400 font-semibold">
                                {isFa ? 'غیرفعال شد' : 'Disabled'}
                              </span>
                            ) : (
                              <span className="text-emerald-700 dark:text-emerald-400">
                                {isFa ? 'حفظ شد' : 'Kept'}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex items-center justify-end pt-3 border-t border-slate-200 dark:border-slate-800">
          <Button variant="outline" onClick={handleClose}>
            {t.common.close}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
