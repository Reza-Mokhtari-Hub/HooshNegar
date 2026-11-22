import React, { useCallback, useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { RefreshCw, ArrowUpLeft, AlertTriangle } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale, type NavSectionId } from '../../i18n';
import { Button, EmptyState, StatusText, Surface, TableSkeleton } from '../ui/primitives';
import type { ProviderType } from '../../shared/validation';

interface DashboardMetrics {
  kpis: {
    totalUsers: number;
    activeUsers: number;
    totalProviders: number;
    activeModels: number;
    totalGenerationRequests: number;
    activeSubscriptions: number;
  };
  usageSeries: Array<{ date: string; requests: number; credits: number }>;
  providerStatuses: Array<{
    id: string;
    name: string;
    providerType: ProviderType;
    connectionStatus: 'untested' | 'connected' | 'degraded' | 'failed';
    isActive: boolean;
    lastTestLatencyMs: number | null;
    lastTestedAt: string | null;
  }>;
  recentUsers: Array<{
    id: string;
    email: string | null;
    status: string;
    locale: string;
    createdAt: string;
    displayName: string | null;
    telegramUsername: string | null;
  }>;
  recentTransactions: Array<{
    id: string;
    amount: number;
    currency: string;
    gateway: string;
    status: string;
    createdAt: string;
    userEmail: string | null;
  }>;
  systemHealth: {
    database: { ok: boolean; mode: 'neon_postgres' | 'cloudflare_durable_object' | 'embedded_pglite' };
    encryption: { ok: boolean; source: 'env' | 'dev_local_file' | 'missing' };
    telegramBot: {
      configured: boolean;
      isActive: boolean;
      connectionStatus: 'untested' | 'connected' | 'degraded' | 'failed';
      botUsername: string;
    };
    warnings: string[];
  };
}

export function DashboardSection({
  locale,
  onNavigate,
}: {
  locale: Locale;
  onNavigate: (section: NavSectionId) => void;
}) {
  const t = DICTIONARIES[locale];
  const [data, setData] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<DashboardMetrics>('/api/dashboard/metrics');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در بارگذاری داشبورد');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const kpiCards = data
    ? [
        {
          label: locale === 'fa' ? 'کل کاربران ثبت‌نام‌شده' : 'Total Registered Users',
          value: data.kpis.totalUsers,
          sub:
            locale === 'fa'
              ? `${formatNumber(data.kpis.activeUsers, locale)} کاربر فعال`
              : `${formatNumber(data.kpis.activeUsers, locale)} active`,
          target: 'users' as NavSectionId,
        },
        {
          label: locale === 'fa' ? 'ارائه‌دهندگان هوش مصنوعی' : 'AI Providers',
          value: data.kpis.totalProviders,
          sub: locale === 'fa' ? 'پیکربندی‌شده با AES-256-GCM' : 'Encrypted via AES-256-GCM',
          target: 'providers' as NavSectionId,
        },
        {
          label: locale === 'fa' ? 'مدل‌های فعال هوش مصنوعی' : 'Active AI Models',
          value: data.kpis.activeModels,
          sub: locale === 'fa' ? 'مجهز به ماتریس قابلیت‌ها' : 'Capability-indexed',
          target: 'models' as NavSectionId,
        },
        {
          label: locale === 'fa' ? 'کل درخواست‌های تولید' : 'Total Generation Requests',
          value: data.kpis.totalGenerationRequests,
          sub: locale === 'fa' ? 'موتور چندوجهی هوش مصنوعی فعال' : 'Multi-modal AI engine active',
          target: 'analytics' as NavSectionId,
        },
        {
          label: locale === 'fa' ? 'اشتراک‌های فعال فعلی' : 'Active Subscriptions',
          value: data.kpis.activeSubscriptions,
          sub: locale === 'fa' ? 'پرداخت رسمی تلگرام استارز (XTR)' : 'Telegram Stars (XTR) billing',
          target: 'finance' as NavSectionId,
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.dashboard}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'آمار واقعی مستقیماً از پایگاه‌داده PostgreSQL محاسبه می‌شود.'
              : 'Live operational metrics queried directly from PostgreSQL.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      {error && (
        <div className="p-4 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* KPI Strip */}
      {loading && !data ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Surface key={i} className="p-5 space-y-3">
              <div className="h-3 w-24 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
              <div className="h-7 w-16 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
              <div className="h-3 w-28 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
            </Surface>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {kpiCards.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => onNavigate(item.target)}
              className="text-start bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 rounded-xl p-5 transition-colors cursor-pointer group"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {item.label}
                </span>
                <ArrowUpLeft className="w-3.5 h-3.5 text-slate-400 group-hover:text-blue-600 transition-colors shrink-0" />
              </div>
              <div
                className={`text-2xl font-bold text-slate-900 dark:text-slate-100 mt-2.5 tabular-nums ${locale === 'en' ? 'font-mono' : ''}`}
              >
                {formatNumber(item.value, locale)}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">{item.sub}</div>
            </button>
          ))}
        </div>
      )}

      {/* Usage Chart + System Health */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Surface className="lg:col-span-2 p-6">
          <div className="flex items-center justify-between gap-4 mb-5">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {locale === 'fa' ? 'روند درخواست‌ها و مصرف اعتبار' : 'Request & Credit Usage Trend'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {locale === 'fa'
                  ? 'تجمیع روزانه از جدول usage_records'
                  : 'Daily aggregation from usage_records'}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate('analytics')}>
              {locale === 'fa' ? 'مشاهده تحلیل کامل' : 'Full Analytics'}
            </Button>
          </div>

          {!data || data.usageSeries.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'هنوز درخواست هوش مصنوعی ثبت نشده است' : 'No AI usage recorded yet'}
              description={
                locale === 'fa'
                  ? 'پس از اتصال ارائه‌دهندگان و ثبت درخواست‌های کاربران در ربات تلگرام، نمودار مصرف واقعی روزانه اینجا نمایش داده می‌شود.'
                  : 'Real daily request and credit consumption charts will appear here once generation traffic is processed.'
              }
              action={
                <Button variant="outline" size="sm" onClick={() => onNavigate('providers')}>
                  {locale === 'fa' ? 'پیکربندی ارائه‌دهندگان' : 'Configure AI Providers'}
                </Button>
              }
            />
          ) : (
            <div className="h-64" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.usageSeries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey="requests"
                    stroke="#1D4ED8"
                    fill="#1D4ED8"
                    fillOpacity={0.12}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Surface>

        <Surface className="p-6 flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {locale === 'fa' ? 'سلامت زیرساخت و امنیت' : 'System Health & Readiness'}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {locale === 'fa' ? 'وضعیت لحظه‌ای سرویس‌های حیاتی پلتفرم' : 'Real-time status of core platform services'}
            </p>

            {data && (
              <dl className="mt-5 divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                <div className="py-3 flex items-center justify-between gap-3">
                  <dt className="text-slate-600 dark:text-slate-400">
                    {locale === 'fa' ? 'پایگاه‌داده PostgreSQL' : 'PostgreSQL Engine'}
                  </dt>
                  <dd className="text-end">
                    <StatusText tone="success">
                      {data.systemHealth.database.mode === 'neon_postgres'
                        ? 'Neon PostgreSQL'
                        : data.systemHealth.database.mode === 'cloudflare_durable_object'
                          ? locale === 'fa'
                            ? 'Cloudflare Durable SQLite'
                            : 'Cloudflare Durable SQLite'
                          : locale === 'fa'
                            ? 'متصل (PGlite محلی)'
                            : 'Connected (Local PGlite)'}
                    </StatusText>
                  </dd>
                </div>

                <div className="py-3 flex items-center justify-between gap-3">
                  <dt className="text-slate-600 dark:text-slate-400">
                    {locale === 'fa' ? 'رمزنگاری AES-256-GCM' : 'AES-256-GCM Vault'}
                  </dt>
                  <dd className="text-end">
                    <StatusText
                      tone={
                        data.systemHealth.encryption.source === 'env'
                          ? 'success'
                          : data.systemHealth.encryption.source === 'dev_local_file'
                            ? 'warning'
                            : 'danger'
                      }
                    >
                      {data.systemHealth.encryption.source === 'env'
                        ? locale === 'fa'
                          ? 'فعال (متغیر محیطی)'
                          : 'Active (ENV Key)'
                        : data.systemHealth.encryption.source === 'dev_local_file'
                          ? locale === 'fa'
                            ? 'فعال (کلید توسعه محلی)'
                            : 'Active (Local Dev Key)'
                          : locale === 'fa'
                            ? 'پیکربندی نشده'
                            : 'Missing Master Key'}
                    </StatusText>
                  </dd>
                </div>

                <div className="py-3 flex items-center justify-between gap-3">
                  <dt className="text-slate-600 dark:text-slate-400">
                    {locale === 'fa' ? 'ربات تلگرام' : 'Telegram Bot'}
                  </dt>
                  <dd className="text-end">
                    <StatusText
                      tone={
                        data.systemHealth.telegramBot.connectionStatus === 'connected'
                          ? 'success'
                          : data.systemHealth.telegramBot.configured
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {!data.systemHealth.telegramBot.configured
                        ? locale === 'fa'
                          ? 'توکن ثبت نشده'
                          : 'Token Not Configured'
                        : t.connectionStatuses[data.systemHealth.telegramBot.connectionStatus]}
                    </StatusText>
                  </dd>
                </div>

                <div className="py-3 flex items-center justify-between gap-3">
                  <dt className="text-slate-600 dark:text-slate-400">
                    {locale === 'fa' ? 'حفاظت نشست و CSRF' : 'Session & CSRF Guard'}
                  </dt>
                  <dd className="text-end">
                    <StatusText tone="success">
                      {locale === 'fa' ? 'فعال · Argon2id + HttpOnly' : 'Active · Argon2id + HttpOnly'}
                    </StatusText>
                  </dd>
                </div>
              </dl>
            )}
          </div>

          {data && data.systemHealth.warnings.length > 0 && (
            <div className="mt-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 text-[11px] text-amber-900 dark:text-amber-200 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{data.systemHealth.warnings[0]}</span>
            </div>
          )}
        </Surface>
      </div>

      {/* Provider Status + Recent Users & Transactions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Surface className="overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {locale === 'fa' ? 'وضعیت ارائه‌دهندگان' : 'Provider Status'}
            </h2>
            <Button variant="ghost" size="sm" onClick={() => onNavigate('providers')}>
              {locale === 'fa' ? 'مدیریت' : 'Manage'}
            </Button>
          </div>
          {loading && !data ? (
            <TableSkeleton rows={3} cols={2} />
          ) : !data || data.providerStatuses.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'ارائه‌دهنده‌ای ثبت نشده است' : 'No providers configured'}
              description={
                locale === 'fa'
                  ? 'نخستین ارائه‌دهنده هوش مصنوعی (OpenAI، Gemini، Anthropic و...) را اضافه کنید.'
                  : 'Add your first AI provider to enable model routing.'
              }
              action={
                <Button size="sm" onClick={() => onNavigate('providers')}>
                  {locale === 'fa' ? 'افزودن ارائه‌دهنده' : 'Add Provider'}
                </Button>
              }
            />
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {data.providerStatuses.map((p) => (
                <div key={p.id} className="px-5 py-3.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                      {p.name}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {t.providerTypes[p.providerType]}
                      {p.lastTestLatencyMs !== null ? ` · ${p.lastTestLatencyMs}ms` : ''}
                    </div>
                  </div>
                  <StatusText
                    tone={
                      p.connectionStatus === 'connected'
                        ? 'success'
                        : p.connectionStatus === 'degraded'
                          ? 'warning'
                          : p.connectionStatus === 'failed'
                            ? 'danger'
                            : 'neutral'
                    }
                  >
                    {t.connectionStatuses[p.connectionStatus]}
                  </StatusText>
                </div>
              ))}
            </div>
          )}
        </Surface>

        <Surface className="overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {locale === 'fa' ? 'کاربران اخیر' : 'Recent Users'}
            </h2>
            <Button variant="ghost" size="sm" onClick={() => onNavigate('users')}>
              {t.common.all}
            </Button>
          </div>
          {loading && !data ? (
            <TableSkeleton rows={3} cols={2} />
          ) : !data || data.recentUsers.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'هنوز کاربری ثبت‌نام نکرده است' : 'No users yet'}
              description={
                locale === 'fa'
                  ? 'با شروع تعامل کاربران در ربات تلگرام یا وب‌سایت، فهرست کاربران جدید اینجا نمایش داده می‌شود.'
                  : 'New users registered via Telegram bot or web portal will appear here.'
              }
            />
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {data.recentUsers.map((u) => (
                <div key={u.id} className="px-5 py-3.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                      {u.displayName || u.email || (u.telegramUsername ? `@${u.telegramUsername}` : u.id.slice(0, 8))}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {formatDateTime(u.createdAt, locale)}
                    </div>
                  </div>
                  <StatusText tone={u.status === 'active' ? 'success' : 'warning'}>{u.status}</StatusText>
                </div>
              ))}
            </div>
          )}
        </Surface>

        <Surface className="overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {locale === 'fa' ? 'تراکنش‌های اخیر' : 'Recent Transactions'}
            </h2>
            <Button variant="ghost" size="sm" onClick={() => onNavigate('transactions')}>
              {t.common.all}
            </Button>
          </div>
          {loading && !data ? (
            <TableSkeleton rows={3} cols={2} />
          ) : !data || data.recentTransactions.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'تراکنش مالی ثبت نشده است' : 'No transactions yet'}
              description={
                locale === 'fa'
                  ? 'پرداخت‌های رسمی تلگرام استارز (XTR) با کلید یکتای idempotency_key پس از خرید در ربات اینجا ثبت می‌شوند.'
                  : 'Idempotent Telegram Stars (XTR) payments will appear here once users complete purchases in the bot.'
              }
            />
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {data.recentTransactions.map((tx) => (
                <div key={tx.id} className="px-5 py-3.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div
                      className={`text-sm font-medium tabular-nums text-slate-900 dark:text-slate-100 ${locale === 'en' ? 'font-mono' : ''}`}
                    >
                      {formatNumber(tx.amount, locale)} {tx.currency}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {tx.gateway} · {formatDateTime(tx.createdAt, locale)}
                    </div>
                  </div>
                  <StatusText tone={tx.status === 'succeeded' ? 'success' : 'neutral'}>{tx.status}</StatusText>
                </div>
              ))}
            </div>
          )}
        </Surface>
      </div>
    </div>
  );
}
