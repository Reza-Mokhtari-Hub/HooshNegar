import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, type Locale } from '../../i18n';
import type { ProviderType } from '../../shared/validation';
import { Button, EmptyState, StatusText, Surface, TableSkeleton } from '../ui/primitives';

interface CredentialItem {
  id: string;
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  label: string;
  keyVersion: number;
  maskedPreview: string;
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.credentials}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'خزانه متمرکز کلیدهای رمزنگاری‌شده با AES-256-GCM. هیچ کلید خام یا متن رمزنگاری‌شده هرگز به مرورگر ارسال نمی‌شود.'
              : 'Centralized AES-256-GCM credential vault. Raw and encrypted key material never leaves the server.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      {feedback && (
        <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs text-slate-700 dark:text-slate-200">
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

      {/* Provider Credentials History & Rotation Table */}
      <Surface className="overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {locale === 'fa' ? 'کلیدهای ارائه‌دهندگان هوش مصنوعی' : 'AI Provider API Credentials'}
          </h2>
        </div>

        {loading ? (
          <TableSkeleton rows={4} cols={6} />
        ) : creds.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'هنوز کلید API ذخیره نشده است' : 'No credentials stored yet'}
            description={
              locale === 'fa'
                ? 'با افزودن ارائه‌دهنده در بخش «ارائه‌دهندگان هوش مصنوعی»، نسخه‌های رمزنگاری‌شده کلیدها در این خزانه ثبت می‌شوند.'
                : 'Encrypted key versions appear here once you register AI providers.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'ارائه‌دهنده' : 'Provider'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'پیش‌نمایش ماسک‌شده' : 'Masked Preview'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'نسخه / الگوریتم' : 'Version / Cipher'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                  <th className="py-3 px-4 text-start">{t.common.createdAt}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {creds.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{c.providerName}</div>
                      <div className="text-[11px] text-slate-500">{t.providerTypes[c.providerType]}</div>
                    </td>
                    <td className="py-3.5 px-4 font-mono">
                      <span dir="ltr" className="inline-block">
                        {c.maskedPreview}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-mono tabular-nums text-slate-600 dark:text-slate-400">
                      <span dir="ltr" className="inline-block">
                        v{c.keyVersion} · {c.encryptionAlgorithm}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusText tone={c.isActive ? 'success' : 'danger'}>
                        {c.isActive
                          ? locale === 'fa'
                            ? 'فعال'
                            : 'Active'
                          : locale === 'fa'
                            ? 'باطل‌شده'
                            : 'Revoked'}
                      </StatusText>
                    </td>
                    <td className="py-3.5 px-4 text-slate-600 dark:text-slate-400">
                      {formatDateTime(c.createdAt, locale)}
                    </td>
                    <td className="py-3.5 px-4 text-end">
                      {c.isActive ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRevoke(c.id)}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40"
                        >
                          <ShieldAlert className="w-3.5 h-3.5" />
                          <span>{locale === 'fa' ? 'باطل‌سازی' : 'Revoke'}</span>
                        </Button>
                      ) : (
                        <span className="text-[11px] text-slate-400">
                          {c.revokedAt ? formatDateTime(c.revokedAt, locale) : '—'}
                        </span>
                      )}
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
