import React, { useCallback, useEffect, useState } from 'react';
import { Pencil, RefreshCw } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, type Locale } from '../../i18n';
import {
  Button,
  EmptyState,
  FieldLabel,
  Input,
  Modal,
  StatusText,
  Surface,
  TableSkeleton,
  Textarea,
} from '../ui/primitives';

interface NotificationTemplateRow {
  id: string;
  templateKey: string;
  titleFa: string;
  bodyFa: string;
  bodyEn: string;
  isEnabled: boolean;
  updatedAt: string;
}

interface NotificationLogRow {
  id: string;
  userId: string;
  userDisplayName: string | null;
  templateKey: string;
  channel: string;
  status: string;
  messageText: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
}

export function NotificationsSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [tab, setTab] = useState<'templates' | 'logs'>('templates');
  const [templates, setTemplates] = useState<NotificationTemplateRow[]>([]);
  const [logs, setLogs] = useState<NotificationLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [editing, setEditing] = useState<NotificationTemplateRow | null>(null);
  const [titleFa, setTitleFa] = useState('');
  const [bodyFa, setBodyFa] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [isEnabled, setIsEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tplRes, logRes] = await Promise.all([
        apiRequest<{ templates: NotificationTemplateRow[] }>('/api/notifications/templates'),
        apiRequest<{ logs: NotificationLogRow[] }>('/api/notifications/logs'),
      ]);
      setTemplates(tplRes.templates);
      setLogs(logRes.logs);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در بارگذاری اعلان‌ها' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (tpl: NotificationTemplateRow) => {
    setEditing(tpl);
    setTitleFa(tpl.titleFa);
    setBodyFa(tpl.bodyFa);
    setBodyEn(tpl.bodyEn ?? '');
    setIsEnabled(tpl.isEnabled);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/notifications/templates/${editing.templateKey}`, {
        method: 'PUT',
        body: {
          titleFa: titleFa.trim(),
          bodyFa: bodyFa.trim(),
          bodyEn: bodyEn.trim(),
          isEnabled,
        },
      });
      setEditing(null);
      setFeedback({ tone: 'success', text: locale === 'fa' ? 'قالب اعلان ذخیره شد.' : 'Notification template saved.' });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ذخیره قالب' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.notifications}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'ویرایش متن اعلان‌های خودکار تلگرام (پرداخت، انقضا، یادآور تمدید، کمبود اعتبار، معرفی، هدیه و تکمیل AI) با جلوگیری از ارسال تکراری.'
              : 'Customize automated Telegram notifications (payments, expirations, renewal reminders, low credits, referrals, AI completion) with deduplicated delivery logs.'}
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
          className={`p-3.5 rounded-xl border text-xs ${
            feedback.tone === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setTab('templates')}
          className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
            tab === 'templates'
              ? 'border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-400'
              : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          {locale === 'fa' ? `قالب‌های اعلان (${templates.length})` : `Templates (${templates.length})`}
        </button>
        <button
          type="button"
          onClick={() => setTab('logs')}
          className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
            tab === 'logs'
              ? 'border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-400'
              : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          {locale === 'fa' ? `تاریخچه ارسال (${logs.length})` : `Delivery Logs (${logs.length})`}
        </button>
      </div>

      {tab === 'templates' ? (
        <Surface className="overflow-hidden">
          {loading ? (
            <TableSkeleton rows={5} cols={4} />
          ) : templates.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'قالبی یافت نشد' : 'No templates found'}
              description={locale === 'fa' ? 'قالب‌های پیش‌فرض به صورت خودکار در زمان راه‌اندازی ثبت می‌شوند.' : 'Default templates are seeded at bootstrap.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'عنوان و کلید' : 'Title & Key'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'متن فارسی' : 'Persian Body'}</th>
                    <th className="py-3 px-4 text-start">{t.common.status}</th>
                    <th className="py-3 px-4 text-end">{t.common.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                  {templates.map((tpl) => (
                    <tr key={tpl.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 align-top">
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">{tpl.titleFa}</div>
                        <div className="font-mono text-[11px] text-slate-500 mt-0.5">
                          <span dir="ltr" className="inline-block">{tpl.templateKey}</span>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-slate-700 dark:text-slate-300 max-w-md whitespace-pre-wrap leading-relaxed">
                        {tpl.bodyFa}
                      </td>
                      <td className="py-3.5 px-4">
                        <StatusText tone={tpl.isEnabled ? 'success' : 'neutral'}>
                          {tpl.isEnabled ? t.common.enabled : t.common.disabled}
                        </StatusText>
                      </td>
                      <td className="py-3.5 px-4 text-end">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(tpl)} aria-label={t.common.edit}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Surface>
      ) : (
        <Surface className="overflow-hidden">
          {loading ? (
            <TableSkeleton rows={4} cols={4} />
          ) : logs.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'اعلانی ارسال نشده است' : 'No notification deliveries logged'}
              description={
                locale === 'fa'
                  ? 'اعلان‌های ارسال‌شده برای پرداخت‌ها، انقضای اشتراک و هشدار کمبود اعتبار اینجا ثبت می‌شوند.'
                  : 'Delivered or queued notifications will be logged here with deduplication keys.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کاربر / قالب' : 'User / Template'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'متن پیام' : 'Message'}</th>
                    <th className="py-3 px-4 text-start">{t.common.status}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'زمان' : 'Timestamp'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                  {logs.map((l) => (
                    <tr key={l.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 align-top">
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {l.userDisplayName || l.userId.slice(0, 8)}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">
                          <span dir="ltr" className="inline-block">{l.templateKey}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-slate-700 dark:text-slate-300 max-w-md whitespace-pre-wrap">
                        {l.messageText}
                        {l.errorMessage && (
                          <div className="text-[11px] text-red-600 dark:text-red-400 mt-1">{l.errorMessage}</div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <StatusText tone={l.status === 'sent' ? 'success' : l.status === 'failed' ? 'danger' : 'warning'}>
                          {l.status}
                        </StatusText>
                      </td>
                      <td className="py-3 px-4 text-slate-500">{formatDateTime(l.sentAt ?? l.createdAt, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Surface>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        maxWidth="max-w-xl"
        title={editing ? `${locale === 'fa' ? 'ویرایش قالب:' : 'Edit Template:'} ${editing.templateKey}` : ''}
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="text-[11px] text-slate-500 bg-slate-50 dark:bg-slate-950 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800">
            {locale === 'fa'
              ? 'متغیرهای پشتیبانی‌شده با {{variable}} جایگزین می‌شوند (مثلاً {{planName}}، {{amount}}، {{orderNumber}}، {{balance}}، {{expiresAt}}، {{creditsAdded}}).'
              : 'Placeholders use {{variable}} syntax (e.g. {{planName}}, {{amount}}, {{orderNumber}}, {{balance}}, {{expiresAt}}, {{creditsAdded}}).'}
          </div>
          <div>
            <FieldLabel htmlFor="tpl-title" required>{locale === 'fa' ? 'عنوان فارسی قالب' : 'Persian Title'}</FieldLabel>
            <Input id="tpl-title" required value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
          </div>
          <div>
            <FieldLabel htmlFor="tpl-fa" required>{locale === 'fa' ? 'متن پیام فارسی' : 'Persian Body'}</FieldLabel>
            <Textarea id="tpl-fa" rows={4} required value={bodyFa} onChange={(e) => setBodyFa(e.target.value)} />
          </div>
          <div>
            <FieldLabel htmlFor="tpl-en">{locale === 'fa' ? 'متن پیام انگلیسی (اختیاری)' : 'English Body (Optional)'}</FieldLabel>
            <Textarea id="tpl-en" dir="ltr" rows={3} value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={isEnabled}
              onChange={(e) => setIsEnabled(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-blue-700"
            />
            <span>{locale === 'fa' ? 'ارسال این اعلان فعال باشد' : 'Enable this notification'}</span>
          </label>
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <Button variant="outline" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
            <Button type="submit" disabled={saving}>{saving ? t.common.saving : t.common.save}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
