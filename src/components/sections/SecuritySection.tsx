import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, LogOut } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, type Locale } from '../../i18n';
import { Button, EmptyState, StatusText, Surface, TableSkeleton } from '../ui/primitives';

interface SecurityOverview {
  admins: Array<{
    id: string;
    email: string;
    fullName: string;
    role: string;
    status: string;
    failedLoginAttempts: number;
    lastLoginAt: string | null;
    lastLoginIp: string | null;
  }>;
  sessions: Array<{
    id: string;
    adminEmail: string;
    adminName: string;
    ipAddress: string | null;
    userAgent: string | null;
    expiresAt: string;
    revokedAt: string | null;
    lastSeenAt: string;
    createdAt: string;
    isCurrent: boolean;
    isActive: boolean;
  }>;
  auditLogs: Array<{
    id: string;
    actorEmail: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    severity: 'info' | 'warning' | 'critical';
    status: string;
    ipAddress: string | null;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
}

export function SecuritySection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [data, setData] = useState<SecurityOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<SecurityOverview>('/api/auth/security/overview');
      setData(res);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'خطا در بارگذاری گزارش‌های امنیتی');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRevokeSession = async (sessionId: string) => {
    try {
      await apiRequest(`/api/auth/security/sessions/${sessionId}/revoke`, { method: 'POST' });
      setFeedback(locale === 'fa' ? 'نشست انتخاب‌شده با موفقیت لغو شد.' : 'Session revoked.');
      await load();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'خطا در لغو نشست');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.security}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'مدیریت نشست‌های فعال سمت سرور، کنترل دسترسی مبتنی بر نقش (RBAC) و گزارش ممیزی پالایش‌شده از کلیدهای محرمانه.'
              : 'Server-side session revocation, RBAC administrator directory, and secret-redacted audit trail.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      {feedback && (
        <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs">
          {feedback}
        </div>
      )}

      {/* Active Admin Sessions */}
      <Surface className="overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {locale === 'fa' ? 'نشست‌های مدیریت (Admin Sessions)' : 'Administrator Sessions'}
          </h2>
        </div>
        {loading || !data ? (
          <TableSkeleton rows={3} cols={5} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'مدیر' : 'Administrator'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'نشانی IP' : 'IP Address'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'آخرین فعالیت' : 'Last Seen'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {data.sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="py-3.5 px-4">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {s.adminName}
                        {s.isCurrent && (
                          <span className="ms-2 text-[11px] text-blue-700 dark:text-blue-400">
                            · {locale === 'fa' ? 'نشست فعلی' : 'Current'}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                        <span dir="ltr" className="inline-block">
                          {s.adminEmail}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-slate-600 dark:text-slate-400">
                      <span dir="ltr" className="inline-block">
                        {s.ipAddress ?? '—'}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-slate-600 dark:text-slate-400">
                      {formatDateTime(s.lastSeenAt, locale)}
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusText tone={s.isActive ? 'success' : 'neutral'}>
                        {s.isActive
                          ? locale === 'fa'
                            ? 'فعال'
                            : 'Active'
                          : s.revokedAt
                            ? locale === 'fa'
                              ? 'لغوشده'
                              : 'Revoked'
                            : locale === 'fa'
                              ? 'منقضی'
                              : 'Expired'}
                      </StatusText>
                    </td>
                    <td className="py-3.5 px-4 text-end">
                      {s.isActive && !s.isCurrent ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRevokeSession(s.id)}
                          className="text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                        >
                          <LogOut className="w-3.5 h-3.5" />
                          <span>{locale === 'fa' ? 'لغو نشست' : 'Revoke'}</span>
                        </Button>
                      ) : (
                        <span className="text-[11px] text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      {/* Audit Logs */}
      <Surface className="overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {locale === 'fa' ? 'گزارش ممیزی عملیات حساس (Audit Logs)' : 'Administrative Audit Trail'}
          </h2>
        </div>
        {loading || !data ? (
          <TableSkeleton rows={5} cols={5} />
        ) : data.auditLogs.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'رویداد ممیزی ثبت نشده است' : 'No audit events recorded'}
            description={
              locale === 'fa'
                ? 'هر عملیات ورود، ایجاد ارائه‌دهنده، چرخش کلید و تغییر تنظیمات اینجا ثبت می‌شود.'
                : 'Logins, provider mutations, key rotations, and config updates appear here.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'عملیات' : 'Action'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'عامل' : 'Actor'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'منبع و جزئیات' : 'Resource & Details'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'سطح / وضعیت' : 'Severity / Status'}</th>
                  <th className="py-3 px-4 text-end">{locale === 'fa' ? 'زمان' : 'Timestamp'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {data.auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-4 font-mono text-slate-900 dark:text-slate-100">
                      <span dir="ltr" className="inline-block">
                        {log.action}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-400">
                      <span dir="ltr" className="inline-block">
                        {log.actorEmail ?? 'system'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-slate-400 max-w-sm">
                      <div className="font-mono text-slate-800 dark:text-slate-200">
                        <span dir="ltr" className="inline-block">
                          {log.resourceType}
                        </span>
                      </div>
                      {Object.keys(log.details ?? {}).length > 0 && (
                        <div
                          className="text-[11px] font-mono text-slate-500 mt-0.5 truncate max-w-xs"
                          title={JSON.stringify(log.details)}
                        >
                          <span dir="ltr" className="inline-block">
                            {JSON.stringify(log.details)}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <StatusText
                        tone={
                          log.severity === 'critical' || log.status === 'failure'
                            ? 'danger'
                            : log.severity === 'warning'
                              ? 'warning'
                              : 'success'
                        }
                      >
                        {log.severity} · {log.status}
                      </StatusText>
                    </td>
                    <td className="py-3 px-4 text-end text-slate-500 whitespace-nowrap">
                      {formatDateTime(log.createdAt, locale)}
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
