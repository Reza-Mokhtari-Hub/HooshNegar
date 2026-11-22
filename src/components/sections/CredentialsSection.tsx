import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCcw, ShieldAlert } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import type { CredentialPoolStatus, ProviderType } from '../../shared/validation';
import { Button, EmptyState, StatusText, Surface, TableSkeleton } from '../ui/primitives';

interface CredentialItem {
  id: string;
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  label: string;
  keyVersion: number;
  maskedPreview: string;
  priority: number;
  status: CredentialPoolStatus | string;
  cooldownUntil: string | null;
  failureCount: number;
  lastUsedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  isActive: boolean;
  rotatedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  encryptionAlgorithm: string;
}

interface TelegramCredentialSummary {
  configured: boolean;
  botUsername: string;
  maskedBotToken: string | null;
  maskedWebhookSecret: string | null;
  encryptionAlgorithm: string;
  updatedAt: string;
}

function getPoolStatusDisplay(
  c: CredentialItem,
  locale: Locale,
): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (!c.isActive || c.status === 'disabled') {
    return { label: locale === 'fa' ? 'باطل‌شده' : 'Revoked', tone: 'neutral' };
  }
  if (c.status === 'invalid') {
    return { label: locale === 'fa' ? 'نامعتبر (۴۰۱/۴۰۳)' : 'Invalid Key', tone: 'danger' };
  }
  if (c.status === 'quota_exhausted') {
    return { label: locale === 'fa' ? 'سهمیه تمام‌شده' : 'Quota Exhausted', tone: 'danger' };
  }
  if (c.status === 'rate_limited') {
    return { label: locale === 'fa' ? 'محدودیت نرخ موقت' : 'Rate Limited', tone: 'warning' };
  }
  return { label: locale === 'fa' ? 'سالم و فعال' : 'Active / Healthy', tone: 'success' };
}

export function CredentialsSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [creds, setCreds] = useState<CredentialItem[]>([]);
  const [tgCred, setTgCred] = useState<TelegramCredentialSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{
        providerCredentials: CredentialItem[];
        telegramCredential: TelegramCredentialSummary | null;
      }>('/api/credentials');
      setCreds(res.providerCredentials);
      setTgCred(res.telegramCredential);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'خطا در دریافت خزانه اعتبارنامه‌ها');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRevoke = async (id: string) => {
    try {
      await apiRequest(`/api/credentials/${id}/revoke`, { method: 'POST' });
      setFeedback(locale === 'fa' ? 'اعتبارنامه انتخاب‌شده باطل شد.' : 'Credential revoked.');
      await load();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'خطا در باطل‌سازی کلید');
    }
  };

  const handleResetStatus = async (id: string) => {
    try {
      await apiRequest(`/api/credentials/${id}`, {
        method: 'PATCH',
        body: { resetStatus: true, isActive: true },
      });
      setFeedback(
        locale === 'fa'
          ? 'وضعیت کلید بازنشانی شد و دوباره در چرخه فعال قرار گرفت.'
          : 'Credential status reset to active.',
      );
      await load();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'خطا در بازنشانی وضعیت کلید');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.credentials}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'خزانه متمرکز کلیدهای رمزنگاری‌شده با AES-256-GCM و پایش سلامت استخر Failover.'
              : 'Centralized AES-256-GCM credential vault and failover pool health monitor.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      {feedback && (
        <div
          role="status"
          className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs text-slate-700 dark:text-slate-200"
        >
          {feedback}
        </div>
      )}

      {/* Telegram Encrypted Secrets Summary */}
      <Surface className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {locale === 'fa' ? 'اعتبارنامه‌های ربات تلگرام' : 'Telegram Bot Credentials'}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {tgCred?.configured
                ? `${tgCred.botUsername ? `@${tgCred.botUsername} · ` : ''}AES-256-GCM`
                : locale === 'fa'
                  ? 'توکن ربات تلگرام هنوز پیکربندی نشده است.'
                  : 'Telegram bot token is not configured yet.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-6 text-xs">
            <div>
              <div className="text-[11px] text-slate-500">{locale === 'fa' ? 'توکن ربات' : 'Bot Token'}</div>
              <div className="font-mono text-slate-800 dark:text-slate-200 mt-0.5">
                <span dir="ltr" className="inline-block">
                  {tgCred?.maskedBotToken ?? '—'}
                </span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">{locale === 'fa' ? 'راز وب‌هوک' : 'Webhook Secret'}</div>
              <div className="font-mono text-slate-800 dark:text-slate-200 mt-0.5">
                <span dir="ltr" className="inline-block">
                  {tgCred?.maskedWebhookSecret ?? '—'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Surface>

      {/* Provider Credentials Pool & Health Table */}
      <Surface className="overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {locale === 'fa' ? 'استخر کلیدهای ارائه‌دهندگان هوش مصنوعی' : 'AI Provider API Credential Pool'}
          </h2>
        </div>

        {loading ? (
          <TableSkeleton rows={4} cols={6} />
        ) : creds.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'هنوز کلید API ذخیره نشده است' : 'No credentials stored yet'}
            description={
              locale === 'fa'
                ? 'با افزودن ارائه‌دهنده در بخش «ارائه‌دهندگان هوش مصنوعی»، کلیدهای رمزنگاری‌شده در این خزانه ثبت می‌شوند.'
                : 'Encrypted key versions appear here once you register AI providers.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'ارائه‌دهنده / برچسب' : 'Provider / Label'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'پیش‌نمایش ماسک‌شده' : 'Masked Preview'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'اولویت / نسخه' : 'Priority / Version'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'وضعیت استخر و خطا' : 'Pool Health'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'آخرین استفاده' : 'Last Used'}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {creds.map((c) => {
                  const st = getPoolStatusDisplay(c, locale);
                  const needsReset = !c.isActive || c.status !== 'active' || c.failureCount > 0;
                  return (
                    <tr key={c.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">{c.providerName}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {t.providerTypes[c.providerType]} ·{' '}
                          <span dir="ltr" className="font-mono">
                            {c.label}
                          </span>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 font-mono">
                        <span dir="ltr" className="inline-block">
                          {c.maskedPreview}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 font-mono tabular-nums text-slate-600 dark:text-slate-400">
                        <span dir="ltr" className="inline-block">
                          #{c.priority} · v{c.keyVersion}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <StatusText tone={st.tone}>{st.label}</StatusText>
                        <div className="text-[11px] text-slate-500 mt-0.5 max-w-[240px] truncate" title={c.lastErrorMessage ?? ''}>
                          {c.failureCount > 0 && (
                            <span className="tabular-nums me-1">
                              {locale === 'fa'
                                ? `${formatNumber(c.failureCount, locale)} خطا`
                                : `${c.failureCount} fails`}
                              {c.lastErrorMessage ? ' · ' : ''}
                            </span>
                          )}
                          {c.lastErrorMessage || (c.cooldownUntil ? formatDateTime(c.cooldownUntil, locale) : '')}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-slate-600 dark:text-slate-400">
                        {c.lastUsedAt ? formatDateTime(c.lastUsedAt, locale) : formatDateTime(c.createdAt, locale)}
                      </td>
                      <td className="py-3.5 px-4 text-end">
                        <div className="flex items-center justify-end gap-1.5">
                          {needsReset && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleResetStatus(c.id)}
                              aria-label={`${locale === 'fa' ? 'بازنشانی وضعیت' : 'Reset status'} ${c.maskedPreview}`}
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>{locale === 'fa' ? 'بازنشانی' : 'Reset'}</span>
                            </Button>
                          )}
                          {c.isActive && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRevoke(c.id)}
                              className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40"
                              aria-label={`${locale === 'fa' ? 'باطل‌سازی' : 'Revoke'} ${c.maskedPreview}`}
                            >
                              <ShieldAlert className="w-3.5 h-3.5" />
                              <span>{locale === 'fa' ? 'باطل‌سازی' : 'Revoke'}</span>
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Surface>
    </div>
  );
}
