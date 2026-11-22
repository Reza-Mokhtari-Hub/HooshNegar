import React, { useCallback, useEffect, useState } from 'react';
import { Play, Save } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, type Locale } from '../../i18n';
import type { PlanRecord } from './PlansSection';
import { Button, FieldLabel, Input, Select, Surface } from '../ui/primitives';

interface SystemSettingsDTO {
  appName: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  defaultTimezone: string;
  defaultLanguage: 'fa' | 'en';
  supportContact: string;
  maintenanceMode: boolean;
  registrationEnabled: boolean;
  defaultUserPlanId: string | null;
  globalRequestsPerMinute: number;
  globalRequestsPerDay: number;
  creditValueUsd?: number;
  starValueUsd?: number;
  lowCreditThreshold?: number;
  allowNegativeBalance?: boolean;
  dataRetentionDays?: number;
}

export function SettingsSection({
  locale,
  onAppNameUpdated,
}: {
  locale: Locale;
  onAppNameUpdated?: (name: string) => void;
}) {
  const t = DICTIONARIES[locale];
  const [form, setForm] = useState<SystemSettingsDTO | null>(null);
  const [plans, setPlans] = useState<PlanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningMaint, setRunningMaint] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsRes, plansRes] = await Promise.all([
        apiRequest<{ settings: SystemSettingsDTO }>('/api/settings'),
        apiRequest<{ plans: PlanRecord[] }>('/api/plans'),
      ]);
      setForm(settingsRes.settings);
      setPlans(plansRes.plans);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در بارگذاری تنظیمات' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setFeedback(null);
    try {
      await apiRequest('/api/settings', { method: 'PUT', body: form });
      onAppNameUpdated?.(form.appName);
      setFeedback({
        tone: 'success',
        text: locale === 'fa' ? 'تنظیمات سیستم با موفقیت در پایگاه‌داده ذخیره شد.' : 'System settings saved.',
      });
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ذخیره تنظیمات' });
    } finally {
      setSaving(false);
    }
  };

  const handleRunMaintenance = async () => {
    setRunningMaint(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{
        summary: {
          expiredSubscriptions: number;
          renewalRemindersSent: number;
          cleanedFiles: number;
          staleJobsRecovered: number;
        };
      }>('/api/maintenance/run', { method: 'POST' });
      const s = res.summary;
      setFeedback({
        tone: 'success',
        text:
          locale === 'fa'
            ? `نگهداری دوره‌ای اجرا شد: ${s.expiredSubscriptions} اشتراک منقضی، ${s.renewalRemindersSent} یادآور تمدید، ${s.cleanedFiles} فایل پاک‌سازی، ${s.staleJobsRecovered} صف معوق بازیابی شد.`
            : `Maintenance completed: ${s.expiredSubscriptions} expired, ${s.renewalRemindersSent} reminders, ${s.cleanedFiles} files cleaned, ${s.staleJobsRecovered} stale jobs recovered.`,
      });
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در اجرای نگهداری دوره‌ای' });
    } finally {
      setRunningMaint(false);
    }
  };

  if (loading || !form) {
    return <Surface className="p-6 text-xs text-slate-500">{t.common.loading}</Surface>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.settings}</h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          {locale === 'fa'
            ? 'پیکربندی برندینگ، منطقه زمانی، زبان پیش‌فرض، حالت تعمیر و نگهداری و محدودیت‌های سراسری.'
            : 'Branding, timezone, default language, maintenance mode, and global rate limits.'}
        </p>
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

      <form onSubmit={handleSave} className="space-y-6">
        <Surface className="p-6 space-y-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {locale === 'fa' ? 'هویت بصری و بومی‌سازی' : 'Branding & Localization'}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="sys-name" required>{locale === 'fa' ? 'نام پلتفرم' : 'Application Name'}</FieldLabel>
              <Input
                id="sys-name"
                required
                value={form.appName}
                onChange={(e) => setForm({ ...form, appName: e.target.value })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="sys-logo">{locale === 'fa' ? 'آدرس لوگو (URL اختیاری)' : 'Logo URL (Optional)'}</FieldLabel>
              <Input
                id="sys-logo"
                dir="ltr"
                value={form.logoUrl}
                onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
                placeholder="https://..."
              />
            </div>
            <div>
              <FieldLabel htmlFor="sys-primary">{locale === 'fa' ? 'رنگ اصلی برند' : 'Primary Brand Color'}</FieldLabel>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={form.primaryColor}
                  onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                  className="h-10 w-12 rounded border border-slate-300 dark:border-slate-700 bg-transparent cursor-pointer"
                  aria-label="Primary color picker"
                />
                <Input
                  id="sys-primary"
                  dir="ltr"
                  className="font-mono"
                  value={form.primaryColor}
                  onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                />
              </div>
            </div>
            <div>
              <FieldLabel htmlFor="sys-accent">{locale === 'fa' ? 'رنگ مکمل برند' : 'Accent Color'}</FieldLabel>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={form.accentColor}
                  onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
                  className="h-10 w-12 rounded border border-slate-300 dark:border-slate-700 bg-transparent cursor-pointer"
                  aria-label="Accent color picker"
                />
                <Input
                  id="sys-accent"
                  dir="ltr"
                  className="font-mono"
                  value={form.accentColor}
                  onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
                />
              </div>
            </div>
            <div>
              <FieldLabel htmlFor="sys-tz">{locale === 'fa' ? 'منطقه زمانی پیش‌فرض' : 'Default Timezone'}</FieldLabel>
              <Select
                id="sys-tz"
                value={form.defaultTimezone}
                onChange={(e) => setForm({ ...form, defaultTimezone: e.target.value })}
              >
                <option value="Asia/Tehran">Asia/Tehran (UTC+3:30)</option>
                <option value="UTC">UTC</option>
                <option value="Europe/London">Europe/London</option>
                <option value="Asia/Dubai">Asia/Dubai</option>
              </Select>
            </div>
            <div>
              <FieldLabel htmlFor="sys-lang">{locale === 'fa' ? 'زبان پیش‌فرض سامانه' : 'Default Language'}</FieldLabel>
              <Select
                id="sys-lang"
                value={form.defaultLanguage}
                onChange={(e) => setForm({ ...form, defaultLanguage: e.target.value as 'fa' | 'en' })}
              >
                <option value="fa">فارسی (RTL)</option>
                <option value="en">English (LTR)</option>
              </Select>
            </div>
            <div className="md:col-span-2">
              <FieldLabel htmlFor="sys-support">{locale === 'fa' ? 'اطلاعات تماس پشتیبانی' : 'Support Contact'}</FieldLabel>
              <Input
                id="sys-support"
                value={form.supportContact}
                onChange={(e) => setForm({ ...form, supportContact: e.target.value })}
                placeholder="support@yourdomain.com | @support_handle"
              />
            </div>
          </div>
        </Surface>

        <Surface className="p-6 space-y-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {locale === 'fa' ? 'عملیات، ثبت‌نام و محدودیت‌های سراسری' : 'Operations, Registration & Global Limits'}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <FieldLabel htmlFor="sys-default-plan">{locale === 'fa' ? 'پلن پیش‌فرض کاربران جدید' : 'Default User Plan'}</FieldLabel>
              <Select
                id="sys-default-plan"
                value={form.defaultUserPlanId ?? ''}
                onChange={(e) => setForm({ ...form, defaultUserPlanId: e.target.value || null })}
              >
                <option value="">{locale === 'fa' ? 'انتخاب نشده' : 'None'}</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel htmlFor="sys-rpm">{locale === 'fa' ? 'حداکثر درخواست در دقیقه (سراسری)' : 'Global Requests / Min'}</FieldLabel>
              <Input
                id="sys-rpm"
                type="number"
                min={1}
                value={form.globalRequestsPerMinute}
                onChange={(e) => setForm({ ...form, globalRequestsPerMinute: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="sys-rpd">{locale === 'fa' ? 'حداکثر درخواست روزانه (سراسری)' : 'Global Requests / Day'}</FieldLabel>
              <Input
                id="sys-rpd"
                type="number"
                min={1}
                value={form.globalRequestsPerDay}
                onChange={(e) => setForm({ ...form, globalRequestsPerDay: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-3 border-t border-slate-200 dark:border-slate-800">
            <div>
              <FieldLabel htmlFor="sys-star-usd">{locale === 'fa' ? 'ارزش مرجع هر استارز ($ USD)' : 'Est. Star Value ($ USD)'}</FieldLabel>
              <Input
                id="sys-star-usd"
                type="number"
                step="0.001"
                min={0}
                value={form.starValueUsd ?? 0.013}
                onChange={(e) => setForm({ ...form, starValueUsd: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="sys-cr-usd">{locale === 'fa' ? 'ارزش مرجع هر اعتبار ($ USD)' : 'Est. Credit Value ($ USD)'}</FieldLabel>
              <Input
                id="sys-cr-usd"
                type="number"
                step="0.001"
                min={0}
                value={form.creditValueUsd ?? 0.01}
                onChange={(e) => setForm({ ...form, creditValueUsd: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="sys-low-cr">{locale === 'fa' ? 'آستانه هشدار کمبود اعتبار' : 'Low Credit Alert Threshold'}</FieldLabel>
              <Input
                id="sys-low-cr"
                type="number"
                min={0}
                value={form.lowCreditThreshold ?? 15}
                onChange={(e) => setForm({ ...form, lowCreditThreshold: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="sys-ret-days">{locale === 'fa' ? 'نگهداری داده‌ها (روز)' : 'Data Retention (Days)'}</FieldLabel>
              <Input
                id="sys-ret-days"
                type="number"
                min={7}
                max={3650}
                value={form.dataRetentionDays ?? 365}
                onChange={(e) => setForm({ ...form, dataRetentionDays: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6 pt-2">
            <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.registrationEnabled}
                onChange={(e) => setForm({ ...form, registrationEnabled: e.target.checked })}
                className="w-4 h-4 rounded border-slate-300 text-blue-700"
              />
              <span>{locale === 'fa' ? 'ثبت‌نام کاربران جدید باز باشد' : 'Allow new user registration'}</span>
            </label>

            <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(form.allowNegativeBalance)}
                onChange={(e) => setForm({ ...form, allowNegativeBalance: e.target.checked })}
                className="w-4 h-4 rounded border-slate-300 text-blue-700"
              />
              <span>{locale === 'fa' ? 'اجازه موجودی اعتبار منفی (پیش‌فرض: غیرفعال)' : 'Allow Negative Credit Balance (default: off)'}</span>
            </label>

            <label className="flex items-center gap-2.5 text-xs font-medium text-amber-800 dark:text-amber-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.maintenanceMode}
                onChange={(e) => setForm({ ...form, maintenanceMode: e.target.checked })}
                className="w-4 h-4 rounded border-slate-300 text-amber-600"
              />
              <span>{locale === 'fa' ? 'فعال‌سازی حالت تعمیر و نگهداری (Maintenance Mode)' : 'Enable Maintenance Mode'}</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
            <Button variant="outline" size="sm" onClick={handleRunMaintenance} disabled={runningMaint}>
              <Play className="w-3.5 h-3.5" />
              <span>
                {runningMaint
                  ? locale === 'fa'
                    ? 'در حال اجرای نگهداری...'
                    : 'Running sweep...'
                  : locale === 'fa'
                    ? 'اجرای دستی نگهداری دوره‌ای (انقضا و پاک‌سازی)'
                    : 'Run Maintenance Sweep Now'}
              </span>
            </Button>
            <Button type="submit" disabled={saving}>
              <Save className="w-4 h-4" />
              <span>{saving ? t.common.saving : t.common.save}</span>
            </Button>
          </div>
        </Surface>
      </form>
    </div>
  );
}
