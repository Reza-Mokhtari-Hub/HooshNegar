import React, { useCallback, useEffect, useState } from 'react';
import { PlugZap, Webhook, Save, RefreshCw, Smartphone, Copy, Check, ExternalLink } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import type { ModelRecord } from './ModelsSection';
import { Button, FieldLabel, Input, Select, StatusText, Surface, Textarea } from '../ui/primitives';

interface LiveWebhookStatusDTO {
  configured: boolean;
  hasWebhookSecret: boolean;
  liveStatus: {
    ok: boolean;
    url: string;
    pendingUpdateCount: number;
    lastErrorMessage?: string | null;
    lastErrorDate?: string | null;
    message: string;
  } | null;
  stats: {
    totalEvents: number;
    failedEvents: number;
  };
}

interface TelegramSettingsDTO {
  id: string;
  hasBotToken: boolean;
  maskedBotToken: string | null;
  botUsername: string;
  botDisplayName: string;
  webhookUrl: string;
  hasWebhookSecret: boolean;
  maskedWebhookSecret: string | null;
  isActive: boolean;
  welcomeMessage: string;
  defaultLanguage: 'fa' | 'en';
  supportUsername: string;
  defaultModelId: string | null;
  errorMessages: {
    rateLimit: string;
    maintenance: string;
    providerError: string;
    insufficientCredits: string;
    unsupportedCapability: string;
  };
  connectionStatus: 'untested' | 'connected' | 'degraded' | 'failed';
  lastTestedAt: string | null;
  lastTestMessage: string | null;
}

export function TelegramSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [settings, setSettings] = useState<TelegramSettingsDTO | null>(null);
  const [webhookStatus, setWebhookStatus] = useState<LiveWebhookStatusDTO | null>(null);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncingWebhook, setSyncingWebhook] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [botToken, setBotToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [miniAppUrl, setMiniAppUrl] = useState('');
  const [copiedMiniApp, setCopiedMiniApp] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tgRes, modelsRes, whRes] = await Promise.all([
        apiRequest<{ settings: TelegramSettingsDTO; suggestedWebhookUrl?: string; miniAppUrl?: string }>('/api/telegram'),
        apiRequest<{ models: ModelRecord[] }>('/api/models'),
        apiRequest<LiveWebhookStatusDTO>('/api/telegram/webhook-status').catch(() => null),
      ]);
      const browserHttpsOrigin =
        typeof window !== 'undefined' && window.location.origin.startsWith('https://')
          ? window.location.origin
          : '';
      const browserHttpsWebhook = browserHttpsOrigin
        ? `${browserHttpsOrigin}/api/telegram/webhook`
        : '';
      const resolvedWebhookUrl =
        tgRes.settings.webhookUrl || tgRes.suggestedWebhookUrl || browserHttpsWebhook;
      setSettings({
        ...tgRes.settings,
        webhookUrl: resolvedWebhookUrl,
      });
      setMiniAppUrl(
        tgRes.miniAppUrl ||
          (browserHttpsOrigin ? `${browserHttpsOrigin}/miniapp` : typeof window !== 'undefined' ? `${window.location.origin}/miniapp` : ''),
      );
      setModels(modelsRes.models);
      if (whRes) setWebhookStatus(whRes);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در بارگذاری تنظیمات تلگرام' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{
        settings: TelegramSettingsDTO;
        miniAppUrl?: string;
        connectionResult?: { ok: boolean; message: string; latencyMs: number } | null;
        webhookSyncResult?: { ok: boolean; message: string } | null;
        menuButtonSyncResult?: { ok: boolean; message: string } | null;
      }>('/api/telegram', {
        method: 'PUT',
        body: {
          botToken: botToken.trim(),
          botUsername: settings.botUsername,
          botDisplayName: settings.botDisplayName,
          webhookUrl: settings.webhookUrl,
          webhookSecret: webhookSecret.trim(),
          isActive: settings.isActive,
          welcomeMessage: settings.welcomeMessage,
          defaultLanguage: settings.defaultLanguage,
          supportUsername: settings.supportUsername,
          defaultModelId: settings.defaultModelId || null,
          errorMessages: settings.errorMessages,
        },
      });
      if (res.settings) setSettings(res.settings);
      if (res.miniAppUrl) setMiniAppUrl(res.miniAppUrl);
      setBotToken('');
      setWebhookSecret('');

      if (res.connectionResult && !res.connectionResult.ok) {
        setFeedback({
          tone: 'danger',
          text: res.connectionResult.message,
        });
      } else if (res.webhookSyncResult && !res.webhookSyncResult.ok) {
        setFeedback({
          tone: 'danger',
          text: `${res.connectionResult?.message ?? ''} — خطا در ثبت وب‌هوک: ${res.webhookSyncResult.message}`,
        });
      } else if (res.connectionResult?.ok && res.webhookSyncResult?.ok) {
        const menuSuffix = res.menuButtonSyncResult?.ok ? ` — ${res.menuButtonSyncResult.message}` : '';
        setFeedback({
          tone: 'success',
          text: `${res.connectionResult.message} (${res.connectionResult.latencyMs}ms) — ${res.webhookSyncResult.message}${menuSuffix}`,
        });
      } else if (res.connectionResult?.ok) {
        setFeedback({
          tone: 'success',
          text: `${res.connectionResult.message} (${res.connectionResult.latencyMs}ms)`,
        });
      } else {
        setFeedback({
          tone: 'success',
          text:
            locale === 'fa'
              ? 'تنظیمات ربات تلگرام ذخیره شد (توکن‌ها با AES-256-GCM رمزنگاری شدند).'
              : 'Telegram bot configuration saved (tokens encrypted with AES-256-GCM).',
        });
      }
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ذخیره تنظیمات' });
    } finally {
      setSaving(false);
    }
  };

  const handleTestBot = async () => {
    setTesting(true);
    setFeedback(null);
    try {
      const candidate = botToken.trim();
      const res = await apiRequest<{ result: { ok: boolean; message: string; latencyMs: number } }>(
        '/api/telegram/test-connection',
        {
          method: 'POST',
          body: candidate ? { botToken: candidate } : {},
        },
      );
      setFeedback({
        tone: res.result.ok ? 'success' : 'danger',
        text: `${res.result.message} (${res.result.latencyMs}ms)`,
      });
      if (!candidate) {
        await load();
      }
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در تست ربات' });
    } finally {
      setTesting(false);
    }
  };

  const handleSyncWebhook = async () => {
    setSyncingWebhook(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{
        ok: boolean;
        message: string;
        miniAppUrl?: string;
        menuButtonSyncResult?: { ok: boolean; message: string } | null;
      }>('/api/telegram/set-webhook', {
        method: 'POST',
        body: { webhookUrl: settings?.webhookUrl },
      });
      if (res.miniAppUrl) setMiniAppUrl(res.miniAppUrl);
      const menuNote = res.menuButtonSyncResult?.ok ? ` — ${res.menuButtonSyncResult.message}` : '';
      setFeedback({ tone: res.ok ? 'success' : 'danger', text: `${res.message}${menuNote}` });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ثبت وب‌هوک' });
    } finally {
      setSyncingWebhook(false);
    }
  };

  if (loading || !settings) {
    return (
      <Surface className="p-6 text-xs text-slate-500">{t.common.loading}</Surface>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.telegram}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'پیکربندی امن توکن ربات تلگرام، ثبت و پایش وب‌هوک Grammy، مدل پیش‌فرض و پیام‌های سیستمی ربات.'
              : 'Encrypted bot token, Grammy webhook registration & diagnostics, default model, and system messages.'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestBot}
            disabled={testing || (!settings.hasBotToken && botToken.trim().length < 10)}
          >
            <PlugZap className="w-3.5 h-3.5" />
            <span>{testing ? t.common.testing : locale === 'fa' ? 'تست اتصال ربات' : 'Test Bot Connection'}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncWebhook}
            disabled={syncingWebhook || !settings.hasBotToken}
          >
            <Webhook className="w-3.5 h-3.5" />
            <span>{locale === 'fa' ? 'همگام‌سازی وب‌هوک' : 'Sync Webhook'}</span>
          </Button>
        </div>
      </div>

      {feedback && (
        <div
          role="status"
          className={`p-3.5 rounded-xl border text-xs ${
            feedback.tone === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Status Strip + Live Webhook Diagnostics */}
      <Surface className="p-4 space-y-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <span>
              <span className="text-slate-500">{locale === 'fa' ? 'وضعیت اتصال: ' : 'Status: '}</span>
              <StatusText
                tone={
                  settings.connectionStatus === 'connected'
                    ? 'success'
                    : settings.connectionStatus === 'failed'
                      ? 'danger'
                      : 'neutral'
                }
              >
                {t.connectionStatuses[settings.connectionStatus]}
              </StatusText>
            </span>
            <span className="text-slate-300 dark:text-slate-700">·</span>
            <span>
              <span className="text-slate-500">{locale === 'fa' ? 'توکن فعلی: ' : 'Stored Token: '}</span>
              <span dir="ltr" className="inline-block font-mono text-slate-800 dark:text-slate-200">
                {settings.maskedBotToken ?? (locale === 'fa' ? 'ثبت نشده' : 'Not configured')}
              </span>
            </span>
            <span className="text-slate-300 dark:text-slate-700">·</span>
            <span className="tabular-nums">
              <span className="text-slate-500">{locale === 'fa' ? 'رویدادهای وب‌هوک: ' : 'Webhook Events: '}</span>
              <strong className="text-slate-900 dark:text-slate-100">
                {formatNumber(webhookStatus?.stats.totalEvents ?? 0, locale)}
              </strong>
              {webhookStatus && webhookStatus.stats.failedEvents > 0 && (
                <span className="text-red-600 ms-1.5">
                  ({formatNumber(webhookStatus.stats.failedEvents, locale)} {locale === 'fa' ? 'خطا' : 'failed'})
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {settings.lastTestedAt && (
              <span className="text-slate-500">
                {locale === 'fa' ? 'آخرین بررسی: ' : 'Last tested: '}
                {formatDateTime(settings.lastTestedAt, locale)}
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        {settings.lastTestMessage && (
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-700 dark:text-slate-300">
            <span>{locale === 'fa' ? 'نتیجه آخرین اتصال: ' : 'Last check message: '}</span>
            <span>{settings.lastTestMessage}</span>
          </div>
        )}
        {webhookStatus?.liveStatus && (
          <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-400">
            <div>
              <span>{locale === 'fa' ? 'وب‌هوک زنده تلگرام: ' : 'Live Telegram Webhook: '}</span>
              <span dir="ltr" className="inline-block font-mono text-slate-800 dark:text-slate-200">
                {webhookStatus.liveStatus.url || (locale === 'fa' ? 'ثبت نشده' : 'Not set')}
              </span>
            </div>
            <div className="tabular-nums">
              {locale === 'fa' ? 'صف انتظار تلگرام: ' : 'Pending updates: '}
              <strong>{formatNumber(webhookStatus.liveStatus.pendingUpdateCount, locale)}</strong>
              {webhookStatus.liveStatus.lastErrorMessage && (
                <span className="text-red-600 ms-2">· {webhookStatus.liveStatus.lastErrorMessage}</span>
              )}
            </div>
          </div>
        )}
      </Surface>

      {/* Telegram Mini App Integration Info */}
      <Surface className="p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400 flex items-center justify-center shrink-0">
            <Smartphone className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-slate-900 dark:text-slate-100">
              {locale === 'fa' ? 'مینی‌اپ تلگرام (Telegram Mini App)' : 'Telegram Mini App'}
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
              {locale === 'fa'
                ? 'با همگام‌سازی وب‌هوک، دکمه منوی چت تلگرام و دکمه شیشه‌ای دستور /start و /app به‌صورت خودکار به این مینی‌اپ متصل می‌شوند.'
                : 'Syncing the webhook automatically binds Telegram Chat Menu Button and /start /app inline buttons to this Mini App.'}
            </p>
            {miniAppUrl && (
              <div className="mt-1.5 flex items-center gap-2 text-[11px]">
                <span className="text-slate-500">{locale === 'fa' ? 'آدرس مینی‌اپ: ' : 'Mini App URL: '}</span>
                <span dir="ltr" className="font-mono text-slate-800 dark:text-slate-200 truncate max-w-md">
                  {miniAppUrl}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {miniAppUrl && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(miniAppUrl);
                setCopiedMiniApp(true);
                setTimeout(() => setCopiedMiniApp(false), 1800);
              }}
            >
              {copiedMiniApp ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedMiniApp ? (locale === 'fa' ? 'کپی شد' : 'Copied') : locale === 'fa' ? 'کپی لینک' : 'Copy URL'}</span>
            </Button>
          )}
          <a
            href="/miniapp"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>{locale === 'fa' ? 'پیش‌نمایش مینی‌اپ' : 'Open Mini App'}</span>
          </a>
        </div>
      </Surface>

      <form onSubmit={handleSave} className="space-y-6">
        <Surface className="p-6 space-y-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {locale === 'fa' ? 'احراز هویت و اتصال ربات' : 'Bot Authentication & Webhook'}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="tg-token">
                {locale === 'fa'
                  ? 'توکن ربات تلگرام (برای جایگزینی وارد کنید)'
                  : 'Bot Token (enter to set or rotate)'}
              </FieldLabel>
              <Input
                id="tg-token"
                type="password"
                dir="ltr"
                value={botToken}
                onChange={(e) => {
                  const val = e.target.value;
                  setBotToken(val);
                  if (val.trim().length > 0 && !settings.hasBotToken && !settings.isActive) {
                    setSettings({ ...settings, isActive: true });
                  }
                }}
                placeholder={settings.maskedBotToken || '1234567890:AAF...'}
                autoComplete="off"
              />
            </div>

            <div>
              <FieldLabel htmlFor="tg-webhook-secret">
                {locale === 'fa' ? 'راز امنیتی وب‌هوک (اختیاری — در صورت خالی بودن خودکار ساخته می‌شود)' : 'Webhook Secret Token (optional)'}
              </FieldLabel>
              <Input
                id="tg-webhook-secret"
                type="password"
                dir="ltr"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder={settings.maskedWebhookSecret || 'خودکار ساخته می‌شود'}
                autoComplete="off"
              />
            </div>

            <div>
              <FieldLabel htmlFor="tg-username">{locale === 'fa' ? 'نام کاربری ربات' : 'Bot Username'}</FieldLabel>
              <Input
                id="tg-username"
                dir="ltr"
                value={settings.botUsername}
                onChange={(e) => setSettings({ ...settings, botUsername: e.target.value })}
                placeholder="HooshNegarBot"
              />
            </div>

            <div>
              <FieldLabel htmlFor="tg-display">{locale === 'fa' ? 'نام نمایشی ربات' : 'Bot Display Name'}</FieldLabel>
              <Input
                id="tg-display"
                value={settings.botDisplayName}
                onChange={(e) => setSettings({ ...settings, botDisplayName: e.target.value })}
                placeholder="دستیار هوش مصنوعی هوش‌نگار"
              />
            </div>

            <div className="md:col-span-2">
              <FieldLabel htmlFor="tg-webhook-url">{locale === 'fa' ? 'آدرس وب‌هوک (HTTPS)' : 'Webhook URL (HTTPS)'}</FieldLabel>
              <Input
                id="tg-webhook-url"
                type="url"
                dir="ltr"
                value={settings.webhookUrl}
                onChange={(e) => setSettings({ ...settings, webhookUrl: e.target.value })}
                placeholder={
                  typeof window !== 'undefined' && window.location.origin.startsWith('https://')
                    ? `${window.location.origin}/api/telegram/webhook`
                    : 'https://your-worker.workers.dev/api/telegram/webhook'
                }
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-200 dark:border-slate-800">
            <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.isActive}
                onChange={(e) => setSettings({ ...settings, isActive: e.target.checked })}
                className="w-4 h-4 rounded border-slate-300 text-blue-700"
              />
              <span>{locale === 'fa' ? 'ربات تلگرام فعال باشد' : 'Enable Telegram Bot'}</span>
            </label>

            <Button type="submit" disabled={saving}>
              <Save className="w-4 h-4" />
              <span>
                {saving
                  ? locale === 'fa'
                    ? 'در حال ذخیره و اتصال...'
                    : 'Saving & Connecting...'
                  : locale === 'fa'
                    ? 'ذخیره و اتصال ربات'
                    : 'Save & Connect Bot'}
              </span>
            </Button>
          </div>
        </Surface>

        <Surface className="p-6 space-y-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {locale === 'fa' ? 'رفتار پیش‌فرض و پیام‌های ربات' : 'Default Behavior & Bot Messages'}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <FieldLabel htmlFor="tg-default-model">{locale === 'fa' ? 'مدل هوش مصنوعی پیش‌فرض' : 'Default AI Model'}</FieldLabel>
              <Select
                id="tg-default-model"
                value={settings.defaultModelId ?? ''}
                onChange={(e) =>
                  setSettings({ ...settings, defaultModelId: e.target.value || null })
                }
              >
                <option value="">{locale === 'fa' ? 'انتخاب نشده' : 'None selected'}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.providerName})
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <FieldLabel htmlFor="tg-lang">{locale === 'fa' ? 'زبان پیش‌فرض ربات' : 'Default Language'}</FieldLabel>
              <Select
                id="tg-lang"
                value={settings.defaultLanguage}
                onChange={(e) =>
                  setSettings({ ...settings, defaultLanguage: e.target.value as 'fa' | 'en' })
                }
              >
                <option value="fa">فارسی (fa)</option>
                <option value="en">English (en)</option>
              </Select>
            </div>

            <div>
              <FieldLabel htmlFor="tg-support">{locale === 'fa' ? 'نام کاربری پشتیبانی تلگرام' : 'Support Username'}</FieldLabel>
              <Input
                id="tg-support"
                dir="ltr"
                value={settings.supportUsername}
                onChange={(e) => setSettings({ ...settings, supportUsername: e.target.value })}
                placeholder="hooshnegar_support"
              />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="tg-welcome" required>
              {locale === 'fa' ? 'پیام خوش‌آمدگویی (/start)' : 'Welcome Message (/start)'}
            </FieldLabel>
            <Textarea
              id="tg-welcome"
              rows={3}
              required
              value={settings.welcomeMessage}
              onChange={(e) => setSettings({ ...settings, welcomeMessage: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="tg-err-rate">{locale === 'fa' ? 'پیام خطای محدودیت نرخ' : 'Rate Limit Error Message'}</FieldLabel>
              <Input
                id="tg-err-rate"
                value={settings.errorMessages.rateLimit}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    errorMessages: { ...settings.errorMessages, rateLimit: e.target.value },
                  })
                }
              />
            </div>
            <div>
              <FieldLabel htmlFor="tg-err-maint">{locale === 'fa' ? 'پیام حالت تعمیر و نگهداری' : 'Maintenance Message'}</FieldLabel>
              <Input
                id="tg-err-maint"
                value={settings.errorMessages.maintenance}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    errorMessages: { ...settings.errorMessages, maintenance: e.target.value },
                  })
                }
              />
            </div>
            <div>
              <FieldLabel htmlFor="tg-err-prov">{locale === 'fa' ? 'پیام خطای ارائه‌دهنده هوش مصنوعی' : 'Provider Error Message'}</FieldLabel>
              <Input
                id="tg-err-prov"
                value={settings.errorMessages.providerError}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    errorMessages: { ...settings.errorMessages, providerError: e.target.value },
                  })
                }
              />
            </div>
            <div>
              <FieldLabel htmlFor="tg-err-credits">{locale === 'fa' ? 'پیام اتمام اعتبار کاربر' : 'Insufficient Credits Message'}</FieldLabel>
              <Input
                id="tg-err-credits"
                value={settings.errorMessages.insufficientCredits}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    errorMessages: { ...settings.errorMessages, insufficientCredits: e.target.value },
                  })
                }
              />
            </div>
          </div>

          <div className="flex justify-end pt-3 border-t border-slate-200 dark:border-slate-800">
            <Button type="submit" disabled={saving}>
              <Save className="w-4 h-4" />
              <span>
                {saving
                  ? locale === 'fa'
                    ? 'در حال ذخیره و اتصال...'
                    : 'Saving & Connecting...'
                  : locale === 'fa'
                    ? 'ذخیره و اتصال ربات'
                    : 'Save & Connect Bot'}
              </span>
            </Button>
          </div>
        </Surface>
      </form>
    </div>
  );
}
