import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatNumber, type Locale } from '../../i18n';
import { MODEL_CATEGORIES, type ModelCategory } from '../../shared/validation';
import type { ProviderRecord } from './ProvidersSection';
import { Button, FieldLabel, Input, Modal, Select } from '../ui/primitives';

export type HealthPruneAction = 'report_only' | 'deactivate_broken' | 'delete_broken';
export type BulkModelManualAction = 'activate' | 'deactivate' | 'delete';
export type ModelHealthStatus =
  | 'healthy'
  | 'rate_limited'
  | 'broken'
  | 'auth_error'
  | 'transient';
export type ModelProbeMethod = 'live_inference' | 'space_check' | 'catalog_check' | 'mock';

interface ModelHealthProbeResult {
  modelId: string;
  modelName: string;
  modelIdentifier: string;
  providerId: string;
  providerName: string;
  category: ModelCategory;
  wasActive: boolean;
  isActiveNow: boolean;
  status: ModelHealthStatus;
  preserved: boolean;
  httpStatus: number | null;
  probeMethod: ModelProbeMethod;
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

interface BulkActionResponse {
  ok: boolean;
  action: BulkModelManualAction;
  affectedCount: number;
  affectedIds: string[];
}

type StatusTab = 'all' | 'healthy' | 'rate_limited' | 'broken' | 'other';

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
  const [action, setAction] = useState<HealthPruneAction>('report_only');
  const [onlyActive, setOnlyActive] = useState(false);

  const [running, setRunning] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [retestingIds, setRetestingIds] = useState<Set<string>>(() => new Set());
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  const [errorText, setErrorText] = useState<string | null>(null);
  const [noticeText, setNoticeText] = useState<string | null>(null);

  const [totalTarget, setTotalTarget] = useState(0);
  const [processedTotal, setProcessedTotal] = useState(0);
  const [results, setResults] = useState<ModelHealthProbeResult[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const cancelRef = useRef(false);

  const nonDeletedResults = useMemo(
    () => results.filter((r) => r.actionTaken !== 'deleted'),
    [results],
  );

  const groups = useMemo(() => {
    const healthy: ModelHealthProbeResult[] = [];
    const rateLimited: ModelHealthProbeResult[] = [];
    const broken: ModelHealthProbeResult[] = [];
    const other: ModelHealthProbeResult[] = [];

    for (const r of results) {
      if (r.status === 'healthy') healthy.push(r);
      else if (r.status === 'rate_limited') rateLimited.push(r);
      else if (r.status === 'broken') broken.push(r);
      else other.push(r);
    }

    const activeNowCount = nonDeletedResults.filter((r) => r.isActiveNow).length;
    const brokenActive = broken.filter((r) => r.actionTaken !== 'deleted' && r.isActiveNow);
    const brokenInactive = broken.filter((r) => r.actionTaken !== 'deleted' && !r.isActiveNow);
    const brokenAlive = broken.filter((r) => r.actionTaken !== 'deleted');
    const rateLimitedActive = rateLimited.filter((r) => r.actionTaken !== 'deleted' && r.isActiveNow);
    const rateLimitedInactive = rateLimited.filter((r) => r.actionTaken !== 'deleted' && !r.isActiveNow);
    const otherActive = other.filter((r) => r.actionTaken !== 'deleted' && r.isActiveNow);
    const otherInactive = other.filter((r) => r.actionTaken !== 'deleted' && !r.isActiveNow);
    const healthyInactive = healthy.filter((r) => r.actionTaken !== 'deleted' && !r.isActiveNow);

    const hasGroupActions =
      brokenActive.length > 0 ||
      brokenInactive.length > 0 ||
      brokenAlive.length > 0 ||
      rateLimitedActive.length > 0 ||
      rateLimitedInactive.length > 0 ||
      otherActive.length > 0 ||
      otherInactive.length > 0 ||
      healthyInactive.length > 0;

    return {
      healthy,
      rateLimited,
      broken,
      other,
      activeNowCount,
      brokenActive,
      brokenInactive,
      brokenAlive,
      rateLimitedActive,
      rateLimitedInactive,
      otherActive,
      otherInactive,
      healthyInactive,
      hasGroupActions,
    };
  }, [results, nonDeletedResults]);

  const filteredResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return results.filter((r) => {
      if (statusFilter === 'healthy' && r.status !== 'healthy') return false;
      if (statusFilter === 'rate_limited' && r.status !== 'rate_limited') return false;
      if (statusFilter === 'broken' && r.status !== 'broken') return false;
      if (statusFilter === 'other' && r.status !== 'auth_error' && r.status !== 'transient') {
        return false;
      }
      if (!q) return true;
      return (
        r.modelName.toLowerCase().includes(q) ||
        r.modelIdentifier.toLowerCase().includes(q) ||
        r.providerName.toLowerCase().includes(q) ||
        r.reasonFa.toLowerCase().includes(q) ||
        r.technicalReason.toLowerCase().includes(q) ||
        String(r.httpStatus ?? '').includes(q)
      );
    });
  }, [results, statusFilter, searchQuery]);

  const selectableFilteredIds = useMemo(
    () => filteredResults.filter((r) => r.actionTaken !== 'deleted').map((r) => r.modelId),
    [filteredResults],
  );

  const allVisibleSelected =
    selectableFilteredIds.length > 0 &&
    selectableFilteredIds.every((id) => selectedIds.has(id));

  const selectedAliveIds = useMemo(() => {
    const aliveSet = new Set(nonDeletedResults.map((r) => r.modelId));
    return Array.from(selectedIds).filter((id) => aliveSet.has(id));
  }, [selectedIds, nonDeletedResults]);

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of selectableFilteredIds) next.delete(id);
      } else {
        for (const id of selectableFilteredIds) next.add(id);
      }
      return next;
    });
  };

  const toggleSelectOne = (modelId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const handleStartScan = async () => {
    cancelRef.current = false;
    setRunning(true);
    setFinished(false);
    setErrorText(null);
    setNoticeText(null);
    setConfirmDeleteKey(null);
    setResults([]);
    setSelectedIds(new Set());
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

  const runBulkManualAction = async (
    targetIds: string[],
    manualAction: BulkModelManualAction,
    labelFa: string,
    labelEn: string,
  ) => {
    const cleanIds = Array.from(new Set(targetIds));
    if (cleanIds.length === 0) return;

    setMutating(true);
    setErrorText(null);
    setNoticeText(null);
    setConfirmDeleteKey(null);

    try {
      const resp = await apiRequest<BulkActionResponse>('/api/models/bulk-action', {
        method: 'POST',
        body: { modelIds: cleanIds, action: manualAction },
      });

      const affectedSet = new Set(resp.affectedIds);
      setResults((prev) =>
        prev.map((row) => {
          if (!affectedSet.has(row.modelId)) return row;
          if (manualAction === 'activate') {
            return { ...row, isActiveNow: true, actionTaken: 'kept' };
          }
          if (manualAction === 'deactivate') {
            return { ...row, isActiveNow: false, actionTaken: 'deactivated' };
          }
          return { ...row, isActiveNow: false, actionTaken: 'deleted' };
        }),
      );

      if (manualAction === 'delete') {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of resp.affectedIds) next.delete(id);
          return next;
        });
      }

      setNoticeText(
        isFa
          ? `${formatNumber(resp.affectedCount, locale)} مدل با موفقیت ${labelFa}.`
          : `${resp.affectedCount} models ${labelEn}.`,
      );
      await onCompleted();
    } catch (err) {
      setErrorText(
        err instanceof Error
          ? err.message
          : isFa
            ? 'خطا در اعمال تغییر دستی روی مدل‌ها.'
            : 'Failed to apply bulk action.',
      );
    } finally {
      setMutating(false);
    }
  };

  const handleToggleSingleModel = async (row: ModelHealthProbeResult) => {
    if (row.actionTaken === 'deleted') return;
    const nextActive = !row.isActiveNow;
    setRowBusyId(row.modelId);
    setErrorText(null);
    setNoticeText(null);
    setConfirmDeleteKey(null);

    try {
      await apiRequest<BulkActionResponse>('/api/models/bulk-action', {
        method: 'POST',
        body: {
          modelIds: [row.modelId],
          action: nextActive ? 'activate' : 'deactivate',
        },
      });
      setResults((prev) =>
        prev.map((item) =>
          item.modelId === row.modelId
            ? {
                ...item,
                isActiveNow: nextActive,
                actionTaken: nextActive ? 'kept' : 'deactivated',
              }
            : item,
        ),
      );
      setNoticeText(
        isFa
          ? `مدل «${row.modelName}» ${nextActive ? 'فعال' : 'غیرفعال'} شد.`
          : `Model "${row.modelName}" ${nextActive ? 'activated' : 'deactivated'}.`,
      );
      await onCompleted();
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'خطا در تغییر وضعیت مدل.');
    } finally {
      setRowBusyId(null);
    }
  };

  const handleDeleteSingleModel = async (row: ModelHealthProbeResult) => {
    if (row.actionTaken === 'deleted') return;
    setRowBusyId(row.modelId);
    setErrorText(null);
    setNoticeText(null);
    setConfirmDeleteKey(null);

    try {
      await apiRequest<BulkActionResponse>('/api/models/bulk-action', {
        method: 'POST',
        body: { modelIds: [row.modelId], action: 'delete' },
      });
      setResults((prev) =>
        prev.map((item) =>
          item.modelId === row.modelId
            ? { ...item, isActiveNow: false, actionTaken: 'deleted' }
            : item,
        ),
      );
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(row.modelId);
        return next;
      });
      setNoticeText(
        isFa ? `مدل «${row.modelName}» حذف شد.` : `Model "${row.modelName}" deleted.`,
      );
      await onCompleted();
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'خطا در حذف مدل.');
    } finally {
      setRowBusyId(null);
    }
  };

  const handleRetestModels = async (modelIds: string[]) => {
    const cleanIds = Array.from(new Set(modelIds)).slice(0, 20);
    if (cleanIds.length === 0) return;

    setRetestingIds((prev) => {
      const next = new Set(prev);
      for (const id of cleanIds) next.add(id);
      return next;
    });
    setErrorText(null);
    setNoticeText(null);

    try {
      const batch = await apiRequest<BatchModelHealthResponse>('/api/models/health-check', {
        method: 'POST',
        body: {
          modelIds: cleanIds,
          onlyActive: false,
          offset: 0,
          limit: cleanIds.length,
          action: 'report_only',
        },
      });

      const updatedById = new Map(batch.results.map((r) => [r.modelId, r]));
      setResults((prev) =>
        prev.map((row) => updatedById.get(row.modelId) ?? row),
      );
      setNoticeText(
        isFa
          ? `تست مجدد ${formatNumber(batch.results.length, locale)} مدل انجام شد.`
          : `Re-tested ${batch.results.length} model(s).`,
      );
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'خطا در تست مجدد مدل.');
    } finally {
      setRetestingIds((prev) => {
        const next = new Set(prev);
        for (const id of cleanIds) next.delete(id);
        return next;
      });
    }
  };

  const handleStop = () => {
    cancelRef.current = true;
  };

  const handleClose = () => {
    if (running) {
      cancelRef.current = true;
    }
    setConfirmDeleteKey(null);
    onClose();
  };

  const probeMethodLabel = (method: ModelProbeMethod): string => {
    if (method === 'live_inference') return isFa ? 'تست زنده' : 'Live Probe';
    if (method === 'space_check') return isFa ? 'بررسی Space' : 'Space Check';
    if (method === 'catalog_check') return isFa ? 'کاتالوگ' : 'Catalog';
    return isFa ? 'شبیه‌سازی' : 'Mock';
  };

  const progressPct =
    totalTarget > 0 ? Math.min(100, Math.round((processedTotal / totalTarget) * 100)) : 0;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      maxWidth="max-w-5xl"
      title={isFa ? 'پالایش دقیق و مدیریت دستی مدل‌ها' : 'Precision Model Health Check & Manual Controls'}
      description={
        isFa
          ? 'تست واقعی مدل‌ها با بررسی کامل پاسخ API، تفکیک دقیق لیمیت موقت از خرابی واقعی، و کنترل دستی فعال/غیرفعال یا حذف.'
          : 'Live payload-verified model health probing with separate controls for broken, rate-limited, and healthy models.'
      }
    >
      <div className="space-y-4">
        {/* Guarantee Banner (shown before scan so results table gets maximum vertical height) */}
        {results.length === 0 && !running && (
          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/50 flex items-start gap-2.5 text-xs text-slate-700 dark:text-slate-300">
            <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
            <div className="leading-relaxed">
              <strong className="font-semibold text-slate-900 dark:text-slate-100">
                {isFa ? 'تست دقیق با تأیید خروجی واقعی:' : 'Payload-Verified Live Testing:'}
              </strong>{' '}
              {isFa
                ? 'در حالت پالایش خودکار، مدل‌های دارای Rate Limit موقت (429)، خطای موقت (5xx) یا خطای کلید (401) هرگز خودکار حذف نمی‌شوند؛ اما بعد از تست می‌توانید هر گروه (خراب‌ها، لیمیت‌دارها، خطای موقت یا تک‌تک مدل‌ها) را به‌صورت دستی فعال، غیرفعال، تست مجدد یا حذف کنید.'
                : 'Automatic pruning never removes rate-limited (429), transient (5xx), or auth-error (401) models. After scanning, you can manually enable, disable, re-test, or delete any individual model or group.'}
            </div>
          </div>
        )}

        {/* Filters & Scan Mode */}
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
              {isFa ? 'حالت اجرا' : 'Scan Mode'}
            </FieldLabel>
            <Select
              id="prune-action"
              disabled={running}
              value={action}
              onChange={(e) => setAction(e.target.value as HealthPruneAction)}
            >
              <option value="report_only">
                {isFa ? 'تست دقیق و مدیریت دستی (پیشنهادی)' : 'Inspect & manual control (Recommended)'}
              </option>
              <option value="deactivate_broken">
                {isFa ? 'تست + غیرفعال‌سازی خودکار خراب‌ها' : 'Scan + auto-disable broken'}
              </option>
              <option value="delete_broken">
                {isFa ? 'تست + حذف خودکار خراب‌ها' : 'Scan + auto-delete broken'}
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
            <span>
              {isFa
                ? 'فقط مدل‌های فعال فعلی بررسی شوند (برای تست مجدد غیرفعال‌ها، تیک را بردارید)'
                : 'Scan currently active models only (uncheck to include disabled models)'}
            </span>
          </label>

          <div className="flex items-center gap-2">
            {running ? (
              <Button variant="danger" size="sm" onClick={handleStop}>
                <Square className="w-3.5 h-3.5" />
                <span>{isFa ? 'توقف تست' : 'Stop Scan'}</span>
              </Button>
            ) : (
              <Button size="sm" onClick={handleStartScan} disabled={mutating}>
                <Play className="w-3.5 h-3.5" />
                <span>{isFa ? 'شروع تست دقیق مدل‌ها' : 'Start Precision Health Check'}</span>
              </Button>
            )}
          </div>
        </div>

        {errorText && (
          <div className="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
            {errorText}
          </div>
        )}

        {noticeText && (
          <div className="p-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-800 dark:text-emerald-200">
            {noticeText}
          </div>
        )}

        {/* Progress & Results */}
        {(running || finished || results.length > 0) && (
          <div className="space-y-3 pt-3 border-t border-slate-200 dark:border-slate-800">
            {/* Progress Row */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
                <span>
                  {running
                    ? isFa
                      ? `در حال تست زنده... (${formatNumber(processedTotal, locale)} از ${formatNumber(totalTarget, locale)} مدل)`
                      : `Probing live models... (${processedTotal} / ${totalTarget})`
                    : isFa
                      ? `تست تکمیل شد · ${formatNumber(processedTotal, locale)} مدل بررسی شد · ${formatNumber(groups.activeNowCount, locale)} مدل هم‌اکنون فعال است`
                      : `Completed · ${processedTotal} checked · ${groups.activeNowCount} currently active`}
                </span>
                <span className="font-mono font-semibold">{progressPct}%</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>

            {/* Interactive Summary Filter Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {(
                [
                  {
                    key: 'all' as StatusTab,
                    label: isFa ? 'همه مدل‌ها' : 'All Models',
                    count: results.length,
                    accent: 'text-slate-900 dark:text-slate-100',
                    activeBorder: 'border-slate-900 dark:border-slate-100 bg-slate-100/80 dark:bg-slate-800/80',
                  },
                  {
                    key: 'healthy' as StatusTab,
                    label: isFa ? 'سالم' : 'Healthy',
                    count: groups.healthy.length,
                    accent: 'text-emerald-700 dark:text-emerald-400',
                    activeBorder: 'border-emerald-600 bg-emerald-50/70 dark:bg-emerald-950/30',
                  },
                  {
                    key: 'rate_limited' as StatusTab,
                    label: isFa ? 'لیمیت موقت (429)' : 'Rate-Limited',
                    count: groups.rateLimited.length,
                    accent: 'text-amber-700 dark:text-amber-400',
                    activeBorder: 'border-amber-600 bg-amber-50/70 dark:bg-amber-950/30',
                  },
                  {
                    key: 'broken' as StatusTab,
                    label: isFa ? 'واقعاً خراب' : 'Broken',
                    count: groups.broken.length,
                    accent: 'text-red-700 dark:text-red-400',
                    activeBorder: 'border-red-600 bg-red-50/70 dark:bg-red-950/30',
                  },
                  {
                    key: 'other' as StatusTab,
                    label: isFa ? 'کلید / خطای موقت' : 'Auth / Transient',
                    count: groups.other.length,
                    accent: 'text-slate-700 dark:text-slate-300',
                    activeBorder: 'border-slate-600 bg-slate-100/70 dark:bg-slate-800/70',
                  },
                ]
              ).map((card) => {
                const isSelected = statusFilter === card.key;
                return (
                  <button
                    key={card.key}
                    type="button"
                    onClick={() => setStatusFilter(card.key)}
                    className={`p-2.5 rounded-lg border text-start transition-colors cursor-pointer ${
                      isSelected
                        ? card.activeBorder
                        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 hover:bg-slate-50 dark:hover:bg-slate-900'
                    }`}
                  >
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {card.label}
                    </div>
                    <div className={`text-lg font-bold tabular-nums mt-0.5 ${card.accent}`}>
                      {formatNumber(card.count, locale)}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* One-Click Manual Group Actions */}
            {results.length > 0 && !running && groups.hasGroupActions && (
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 space-y-2">
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  {isFa ? 'اقدام دستی سریع بر اساس وضعیت' : 'Quick Manual Group Controls'}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Broken group controls */}
                  {groups.brokenActive.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutating}
                      onClick={() =>
                        runBulkManualAction(
                          groups.brokenActive.map((r) => r.modelId),
                          'deactivate',
                          'غیرفعال شد',
                          'deactivated',
                        )
                      }
                    >
                      <PowerOff className="w-3.5 h-3.5 text-red-600" />
                      <span>
                        {isFa
                          ? `غیرفعال کردن خراب‌ها (${formatNumber(groups.brokenActive.length, locale)})`
                          : `Disable Broken (${groups.brokenActive.length})`}
                      </span>
                    </Button>
                  )}

                  {groups.brokenInactive.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutating}
                      onClick={() =>
                        runBulkManualAction(
                          groups.brokenInactive.map((r) => r.modelId),
                          'activate',
                          'فعال شد',
                          'activated',
                        )
                      }
                    >
                      <Power className="w-3.5 h-3.5 text-emerald-600" />
                      <span>
                        {isFa
                          ? `فعال کردن خراب‌ها (${formatNumber(groups.brokenInactive.length, locale)})`
                          : `Enable Broken (${groups.brokenInactive.length})`}
                      </span>
                    </Button>
                  )}

                  {groups.brokenAlive.length > 0 &&
                    (confirmDeleteKey === 'group_broken' ? (
                      <div className="inline-flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={mutating}
                          onClick={() =>
                            runBulkManualAction(
                              groups.brokenAlive.map((r) => r.modelId),
                              'delete',
                              'حذف شد',
                              'deleted',
                            )
                          }
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>
                            {isFa
                              ? `تأیید حذف ${formatNumber(groups.brokenAlive.length, locale)} خراب`
                              : `Confirm Delete (${groups.brokenAlive.length})`}
                          </span>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDeleteKey(null)}
                        >
                          {isFa ? 'انصراف' : 'Cancel'}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mutating}
                        onClick={() => setConfirmDeleteKey('group_broken')}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-red-600" />
                        <span>
                          {isFa
                            ? `حذف خراب‌ها (${formatNumber(groups.brokenAlive.length, locale)})`
                            : `Delete Broken (${groups.brokenAlive.length})`}
                        </span>
                      </Button>
                    ))}

                  {/* Rate-limited group controls */}
                  {groups.rateLimitedActive.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutating}
                      onClick={() =>
                        runBulkManualAction(
                          groups.rateLimitedActive.map((r) => r.modelId),
                          'deactivate',
                          'غیرفعال شد',
                          'deactivated',
                        )
                      }
                    >
                      <PowerOff className="w-3.5 h-3.5 text-amber-600" />
                      <span>
                        {isFa
                          ? `غیرفعال کردن لیمیت‌دارها (${formatNumber(groups.rateLimitedActive.length, locale)})`
                          : `Disable Rate-Limited (${groups.rateLimitedActive.length})`}
                      </span>
                    </Button>
                  )}

                  {groups.rateLimitedInactive.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutating}
                      onClick={() =>
                        runBulkManualAction(
                          groups.rateLimitedInactive.map((r) => r.modelId),
                          'activate',
                          'فعال شد',
                          'activated',
                        )
                      }
                    >
                      <Power className="w-3.5 h-3.5 text-amber-600" />
                      <span>
                        {isFa
                          ? `فعال کردن لیمیت‌دارها (${formatNumber(groups.rateLimitedInactive.length, locale)})`
                          : `Enable Rate-Limited (${groups.rateLimitedInactive.length})`}
                      </span>
                    </Button>
                  )}

                  {/* Auth / Transient group controls */}
                  {groups.otherActive.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutating}
                      onClick={() =>
                        runBulkManualAction(
                          groups.otherActive.map((r) => r.modelId),
                          'deactivate',
                          'غیرفعال شد',
                          'deactivated',
                        )
                      }
                    >
                      <PowerOff className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300" />
                      <span>
                        {isFa
                          ? `غیرفعال کردن خطای موقت/کلید (${formatNumber(groups.otherActive.length, locale)})`
                          : `Disable Auth/Transient (${groups.otherActive.length})`}
                      </span>
                    </Button>
                  )}

                  {groups.otherInactive.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutating}
                      onClick={() =>
                        runBulkManualAction(
                          groups.otherInactive.map((r) => r.modelId),
                          'activate',
                          'فعال شد',
                          'activated',
                        )
                      }
                    >
                      <Power className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300" />
                      <span>
                        {isFa
                          ? `فعال کردن خطای موقت/کلید (${formatNumber(groups.otherInactive.length, locale)})`
                          : `Enable Auth/Transient (${groups.otherInactive.length})`}
                      </span>
                    </Button>
                  )}

                  {/* Re-enable inactive healthy models */}
                  {groups.healthyInactive.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutating}
                      onClick={() =>
                        runBulkManualAction(
                          groups.healthyInactive.map((r) => r.modelId),
                          'activate',
                          'فعال شد',
                          'activated',
                        )
                      }
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                      <span>
                        {isFa
                          ? `فعال کردن سالم‌های غیرفعال (${formatNumber(groups.healthyInactive.length, locale)})`
                          : `Enable Healthy (${groups.healthyInactive.length})`}
                      </span>
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Search + Custom Selection Toolbar */}
            {results.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="relative flex-1 min-w-[220px] max-w-sm">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute top-1/2 -translate-y-1/2 start-3 pointer-events-none" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={
                      isFa
                        ? 'جستجو در نام مدل، شناسه، کد HTTP یا خطا...'
                        : 'Filter by model name, ID, HTTP code, or error...'
                    }
                    className="ps-8 py-1.5 text-xs"
                  />
                </div>

                {selectedAliveIds.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-slate-600 dark:text-slate-300 px-1">
                      {isFa
                        ? `${formatNumber(selectedAliveIds.length, locale)} انتخاب‌شده:`
                        : `${selectedAliveIds.length} selected:`}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutating || running}
                      onClick={() =>
                        runBulkManualAction(selectedAliveIds, 'activate', 'فعال شد', 'activated')
                      }
                    >
                      <Power className="w-3.5 h-3.5 text-emerald-600" />
                      <span>{isFa ? 'فعال' : 'Enable'}</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutating || running}
                      onClick={() =>
                        runBulkManualAction(
                          selectedAliveIds,
                          'deactivate',
                          'غیرفعال شد',
                          'deactivated',
                        )
                      }
                    >
                      <PowerOff className="w-3.5 h-3.5 text-amber-600" />
                      <span>{isFa ? 'غیرفعال' : 'Disable'}</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutating || running || retestingIds.size > 0}
                      onClick={() => handleRetestModels(selectedAliveIds)}
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${retestingIds.size > 0 ? 'animate-spin' : ''}`}
                      />
                      <span>{isFa ? 'تست مجدد' : 'Re-test'}</span>
                    </Button>
                    {confirmDeleteKey === 'selected_bulk' ? (
                      <>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={mutating || running}
                          onClick={() =>
                            runBulkManualAction(selectedAliveIds, 'delete', 'حذف شد', 'deleted')
                          }
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>{isFa ? 'تأیید حذف' : 'Confirm'}</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDeleteKey(null)}
                        >
                          {isFa ? 'لغو' : 'Cancel'}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mutating || running}
                        onClick={() => setConfirmDeleteKey('selected_bulk')}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-red-600" />
                        <span>{isFa ? 'حذف' : 'Delete'}</span>
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Results Table */}
            {results.length > 0 && (
              <div className="max-h-[420px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800">
                <table className="w-full text-start border-collapse text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-900/90 sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="py-2.5 px-2.5 w-8 text-center">
                        <input
                          type="checkbox"
                          aria-label={isFa ? 'انتخاب همه' : 'Select all'}
                          checked={allVisibleSelected}
                          disabled={selectableFilteredIds.length === 0 || running}
                          onChange={toggleSelectAllVisible}
                          className="w-3.5 h-3.5 rounded border-slate-300 text-blue-700 cursor-pointer"
                        />
                      </th>
                      <th className="py-2.5 px-2.5 text-start font-medium text-slate-600 dark:text-slate-400">
                        {isFa ? 'مدل و ارائه‌دهنده' : 'Model & Provider'}
                      </th>
                      <th className="py-2.5 px-2.5 text-start font-medium text-slate-600 dark:text-slate-400">
                        {isFa ? 'نتیجه تست' : 'Health'}
                      </th>
                      <th className="py-2.5 px-2.5 text-start font-medium text-slate-600 dark:text-slate-400">
                        {isFa ? 'تشخیص دقیق' : 'Diagnosis'}
                      </th>
                      <th className="py-2.5 px-2.5 text-start font-medium text-slate-600 dark:text-slate-400">
                        {isFa ? 'وضعیت فعلی' : 'State'}
                      </th>
                      <th className="py-2.5 px-2.5 text-end font-medium text-slate-600 dark:text-slate-400">
                        {isFa ? 'کنترل دستی' : 'Manual Controls'}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                    {filteredResults.length === 0 ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="py-6 text-center text-slate-500 dark:text-slate-400"
                        >
                          {isFa
                            ? 'هیچ مدلی با فیلتر فعلی مطابقت ندارد.'
                            : 'No models match the active filter.'}
                        </td>
                      </tr>
                    ) : (
                      filteredResults.map((row) => {
                        const isDeleted = row.actionTaken === 'deleted';
                        const isBusy = rowBusyId === row.modelId || mutating;
                        const isRetesting = retestingIds.has(row.modelId);
                        const isExpanded = expandedRowId === row.modelId;

                        return (
                          <tr
                            key={row.modelId}
                            className={`transition-colors ${
                              isDeleted
                                ? 'opacity-50 bg-slate-50/50 dark:bg-slate-950/30'
                                : 'hover:bg-slate-50/80 dark:hover:bg-slate-900/40'
                            }`}
                          >
                            <td className="py-2.5 px-2.5 text-center align-top">
                              <input
                                type="checkbox"
                                aria-label={row.modelName}
                                disabled={isDeleted || running}
                                checked={selectedIds.has(row.modelId)}
                                onChange={() => toggleSelectOne(row.modelId)}
                                className="w-3.5 h-3.5 rounded border-slate-300 text-blue-700 cursor-pointer mt-0.5"
                              />
                            </td>

                            <td className="py-2.5 px-2.5 align-top">
                              <div className="font-medium text-slate-900 dark:text-slate-100">
                                {row.modelName}
                              </div>
                              <div
                                className="text-[11px] text-slate-500 font-mono truncate max-w-[200px]"
                                dir="ltr"
                              >
                                {row.modelIdentifier}
                              </div>
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                {row.providerName} · {t.modelCategories[row.category]} ·{' '}
                                {probeMethodLabel(row.probeMethod)}
                              </div>
                            </td>

                            <td className="py-2.5 px-2.5 whitespace-nowrap align-top">
                              {row.status === 'healthy' ? (
                                <div className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                  <span>{isFa ? 'سالم' : 'Healthy'}</span>
                                </div>
                              ) : row.status === 'broken' ? (
                                <div className="inline-flex items-center gap-1 text-red-700 dark:text-red-400 font-medium">
                                  <XCircle className="w-3.5 h-3.5 shrink-0" />
                                  <span>{isFa ? 'خراب' : 'Broken'}</span>
                                </div>
                              ) : row.status === 'rate_limited' ? (
                                <div className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
                                  <Clock className="w-3.5 h-3.5 shrink-0" />
                                  <span>{isFa ? 'لیمیت موقت' : 'Rate Limit'}</span>
                                </div>
                              ) : (
                                <div className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300 font-medium">
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                  <span>
                                    {row.status === 'auth_error'
                                      ? isFa
                                        ? 'خطای کلید'
                                        : 'Auth Err'
                                      : isFa
                                        ? 'خطای موقت'
                                        : 'Transient'}
                                  </span>
                                </div>
                              )}
                              <div className="text-[10px] text-slate-400 font-mono mt-0.5" dir="ltr">
                                {row.httpStatus ? `HTTP ${row.httpStatus}` : 'NET'} · {row.latencyMs}ms
                              </div>
                            </td>

                            <td className="py-2.5 px-2.5 align-top max-w-[260px]">
                              <div className="text-slate-700 dark:text-slate-200 leading-relaxed">
                                {row.reasonFa}
                              </div>
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedRowId(isExpanded ? null : row.modelId)
                                }
                                className="text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 font-mono mt-0.5 text-start cursor-pointer block max-w-full"
                                dir="ltr"
                              >
                                {isExpanded
                                  ? row.technicalReason
                                  : row.technicalReason.length > 64
                                    ? `${row.technicalReason.slice(0, 64)}…`
                                    : row.technicalReason}
                              </button>
                            </td>

                            <td className="py-2.5 px-2.5 whitespace-nowrap align-top">
                              {isDeleted ? (
                                <span className="text-red-600 dark:text-red-400 font-medium">
                                  {isFa ? 'حذف شده' : 'Deleted'}
                                </span>
                              ) : row.isActiveNow ? (
                                <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                                  {isFa ? 'فعال' : 'Active'}
                                </span>
                              ) : (
                                <span className="text-slate-500 dark:text-slate-400 font-medium">
                                  {isFa ? 'غیرفعال' : 'Disabled'}
                                </span>
                              )}
                            </td>

                            <td className="py-2.5 px-2.5 whitespace-nowrap text-end align-top">
                              {isDeleted ? (
                                <span className="text-[11px] text-slate-400">—</span>
                              ) : (
                                <div className="inline-flex items-center justify-end gap-1">
                                  <button
                                    type="button"
                                    disabled={isBusy || running}
                                    onClick={() => handleToggleSingleModel(row)}
                                    title={
                                      row.isActiveNow
                                        ? isFa
                                          ? 'غیرفعال کردن دستی'
                                          : 'Disable manually'
                                        : isFa
                                          ? 'فعال کردن دستی'
                                          : 'Enable manually'
                                    }
                                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                                      row.isActiveNow
                                        ? 'border-amber-200 dark:border-amber-900/60 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40'
                                        : 'border-emerald-200 dark:border-emerald-900/60 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'
                                    }`}
                                  >
                                    {row.isActiveNow ? (
                                      <>
                                        <PowerOff className="w-3 h-3" />
                                        <span>{isFa ? 'غیرفعال' : 'Disable'}</span>
                                      </>
                                    ) : (
                                      <>
                                        <Power className="w-3 h-3" />
                                        <span>{isFa ? 'فعال' : 'Enable'}</span>
                                      </>
                                    )}
                                  </button>

                                  <button
                                    type="button"
                                    disabled={isBusy || running || isRetesting}
                                    onClick={() => handleRetestModels([row.modelId])}
                                    title={isFa ? 'تست مجدد زنده این مدل' : 'Re-test this model'}
                                    className="inline-flex items-center justify-center p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
                                  >
                                    <RefreshCw
                                      className={`w-3 h-3 ${isRetesting ? 'animate-spin' : ''}`}
                                    />
                                  </button>

                                  {confirmDeleteKey === `row_${row.modelId}` ? (
                                    <button
                                      type="button"
                                      disabled={isBusy || running}
                                      onClick={() => handleDeleteSingleModel(row)}
                                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-red-600 text-white text-[11px] font-medium hover:bg-red-700 cursor-pointer disabled:opacity-50"
                                    >
                                      <span>{isFa ? 'تأیید حذف' : 'Confirm'}</span>
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      disabled={isBusy || running}
                                      onClick={() => setConfirmDeleteKey(`row_${row.modelId}`)}
                                      title={isFa ? 'حذف مدل' : 'Delete model'}
                                      className="inline-flex items-center justify-center p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer disabled:opacity-50"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
