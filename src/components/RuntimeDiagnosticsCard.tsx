import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Copy,
  Check,
  Database,
  ServerCrash,
  KeyRound,
} from 'lucide-react';
import type { Locale } from '../i18n';
import { Button, Surface } from './ui/primitives';

export interface ClientEnvVarCheck {
  name: string;
  required: boolean;
  status: 'ok' | 'missing' | 'invalid';
  detail: string;
}

export interface ClientDbProbe {
  ok: boolean;
  latencyMs: number;
  error?: string;
  hint?: string;
}

export interface ClientRuntimeDiagnostics {
  ready: boolean;
  runtime: 'cloudflare_workers' | 'nodejs';
  databaseMode: 'neon_postgres' | 'embedded_pglite';
  checks: ClientEnvVarCheck[];
  missingRequiredVars: string[];
  invalidVars: Array<{ name: string; reason: string }>;
  boundEnvKeys: string[];
  probableCause: string | null;
  fixSteps: string[];
  dbProbe?: ClientDbProbe;
  error?: string;
}

interface RuntimeDiagnosticsCardProps {
  diagnostics: ClientRuntimeDiagnostics;
  locale: Locale;
  retrying: boolean;
  onRetry: () => Promise<void>;
}

export function RuntimeDiagnosticsCard({
  diagnostics,
  locale,
  retrying,
  onRetry,
}: RuntimeDiagnosticsCardProps) {
  const [copied, setCopied] = useState(false);
  const isFa = locale === 'fa';

  const handleCopyReport = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked in some embedded iframes
    }
  };

  return (
    <Surface className="p-6 sm:p-7 border-red-200 dark:border-red-900/70 space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-red-100 dark:bg-red-950/70 text-red-700 dark:text-red-400 flex items-center justify-center shrink-0">
            <ServerCrash className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-bold text-slate-900 dark:text-slate-100">
              {isFa ? 'عیب‌یابی آنی راه‌اندازی سرور' : 'Live Server Startup Diagnostics'}
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {isFa
                ? 'سرویس با خطای اتصال یا کمبود تنظیمات محیطی مواجه شد. علت دقیق در لحظه بررسی شده است:'
                : 'The backend encountered a database or runtime configuration issue. Live diagnostics:'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            dir="ltr"
            className="text-[11px] font-mono px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
          >
            {diagnostics.runtime}
          </span>
        </div>
      </div>

      {/* Probable Cause Banner */}
      {diagnostics.probableCause && (
        <div
          role="alert"
          className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/70 space-y-2.5"
        >
          <div className="flex items-center gap-2 text-xs font-bold text-red-800 dark:text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{isFa ? 'علت اصلی شناسایی‌شده' : 'Detected Root Cause'}</span>
          </div>
          <p className="text-xs text-red-900 dark:text-red-200 leading-relaxed">
            {diagnostics.probableCause}
          </p>
          {diagnostics.fixSteps.length > 0 && (
            <ol className="list-decimal ps-5 space-y-1.5 text-xs text-red-900/90 dark:text-red-200/90 pt-1">
              {diagnostics.fixSteps.map((step, i) => (
                <li key={i} className="leading-relaxed">
                  {step}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {/* Environment Variable Checklist */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-200">
            <KeyRound className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>{isFa ? 'وضعیت متغیرهای محیطی (Runtime)' : 'Runtime Environment Variables'}</span>
          </div>
          {diagnostics.runtime === 'cloudflare_workers' && (
            <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono" dir="ltr">
              Bound: {diagnostics.boundEnvKeys.length > 0 ? diagnostics.boundEnvKeys.join(', ') : 'none'}
            </span>
          )}
        </div>

        <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-50/50 dark:bg-slate-900/40">
          {diagnostics.checks.map((item) => {
            const isOk = item.status === 'ok';
            const isMissingRequired = item.status === 'missing' && item.required;
            const isInvalid = item.status === 'invalid';
            return (
              <div
                key={item.name}
                className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isOk ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : isMissingRequired || isInvalid ? (
                    <XCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                  )}
                  <span dir="ltr" className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                    {item.name}
                  </span>
                  {item.required && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200/80 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                      {isFa ? 'الزامی' : 'Required'}
                    </span>
                  )}
                </div>
                <span
                  className={`text-[11px] leading-relaxed ${
                    isOk
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : isMissingRequired || isInvalid
                        ? 'text-red-700 dark:text-red-300'
                        : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {item.detail}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Live Database Probe Output */}
      {(diagnostics.dbProbe || diagnostics.error) && (
        <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-800 dark:text-slate-200">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span>{isFa ? 'نتیجه تست مستقیم پایگاه‌داده (SELECT 1)' : 'Live Database Probe (SELECT 1)'}</span>
            </div>
            {diagnostics.dbProbe && (
              <span
                dir="ltr"
                className={`text-[11px] font-mono ${
                  diagnostics.dbProbe.ok
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-red-700 dark:text-red-400'
                }`}
              >
                {diagnostics.dbProbe.ok ? `OK (${diagnostics.dbProbe.latencyMs}ms)` : 'FAILED'}
              </span>
            )}
          </div>
          {(diagnostics.dbProbe?.error || diagnostics.error) && (
            <pre
              dir="ltr"
              className="text-[11px] font-mono text-red-700 dark:text-red-300 bg-white dark:bg-slate-900 p-2.5 rounded-lg border border-red-200/70 dark:border-red-900/50 overflow-x-auto whitespace-pre-wrap break-words"
            >
              {diagnostics.dbProbe?.error ?? diagnostics.error}
            </pre>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2.5 pt-2">
        <Button type="button" onClick={() => void onRetry()} disabled={retrying}>
          <RefreshCw className={`w-4 h-4 ${retrying ? 'animate-spin' : ''}`} />
          <span>
            {retrying
              ? isFa
                ? 'در حال بررسی اتصال...'
                : 'Re-checking connection...'
              : isFa
                ? 'بررسی مجدد اتصال و تست دیتابیس'
                : 'Retry Connection & Probe DB'}
          </span>
        </Button>

        <Button type="button" variant="outline" onClick={() => void handleCopyReport()}>
          {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
          <span>
            {copied
              ? isFa
                ? 'گزارش دیباگ کپی شد'
                : 'Copied Diagnostics'
              : isFa
                ? 'کپی گزارش دیباگ (بدون کلید محرمانه)'
                : 'Copy Safe Debug Report'}
          </span>
        </Button>
      </div>
    </Surface>
  );
}
