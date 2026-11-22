import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, History, Ban, CheckCircle2 } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import { Button, EmptyState, Modal, StatusText, Surface, TableSkeleton } from '../ui/primitives';

interface ConnectedUserItem {
  userId: string;
  status: 'active' | 'suspended' | 'banned';
  locale: string;
  displayName: string | null;
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  lastInteractionAt: string | null;
  walletBalance: number;
  reservedBalance: number;
  lifetimeSpent: number;
  totalRequests: number;
  failedRequests: number;
  planName: string;
}

interface UserHistoryResponse {
  requests: Array<{
    id: string;
    capability: string;
    status: string;
    modelName: string | null;
    providerName: string | null;
    creditsCharged: number;
    latencyMs: number | null;
    promptPreview: string | null;
    errorMessage: string | null;
    createdAt: string;
  }>;
  transactions: Array<{
    id: string;
    type: string;
    amount: number;
    balanceAfter: number;
    description: string;
    createdAt: string;
  }>;
  conversations: Array<{
    id: string;
    title: string;
    messageCount: number;
    lastMessageAt: string | null;
  }>;
}

export function ConnectedUsersSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [users, setUsers] = useState<ConnectedUserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [selectedUser, setSelectedUser] = useState<ConnectedUserItem | null>(null);
  const [history, setHistory] = useState<UserHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ users: ConnectedUserItem[] }>('/api/monitor/connected-users');
      setUsers(res.users);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در بارگذاری کاربران تلگرام' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleStatus = async (u: ConnectedUserItem) => {
    const nextStatus = u.status === 'active' ? 'suspended' : 'active';
    try {
      await apiRequest(`/api/users/${u.userId}/status`, {
        method: 'PATCH',
        body: { status: nextStatus },
      });
      setFeedback({
        tone: 'success',
        text:
          nextStatus === 'suspended'
            ? locale === 'fa'
              ? 'دسترسی کاربر در ربات تلگرام معلق شد.'
              : 'User suspended.'
            : locale === 'fa'
              ? 'حساب کاربر مجدداً فعال شد.'
              : 'User reactivated.',
      });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در تغییر وضعیت' });
    }
  };

  const openHistory = async (u: ConnectedUserItem) => {
    setSelectedUser(u);
    setHistory(null);
    setHistoryLoading(true);
    try {
      const res = await apiRequest<UserHistoryResponse>(
        `/api/monitor/connected-users/${u.userId}/history`,
      );
      setHistory(res);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در دریافت تاریخچه' });
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {t.nav.connectedUsers}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'فهرست کاربران متصل از طریق ربات تلگرام به همراه اشتراک فعال، اعتبار کیف‌پول، تعلیق حساب و تاریخچه مصرف.'
              : 'Telegram-linked users with active plans, credit wallets, suspension controls, and usage history.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-xl border text-xs ${
            feedback.tone === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={6} />
        ) : users.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'هنوز کاربری از تلگرام متصل نشده است' : 'No connected Telegram users yet'}
            description={
              locale === 'fa'
                ? 'به‌محض ارسال دستور /start توسط کاربران در ربات تلگرام، حساب داخلی، اشتراک رایگان و کیف‌پول آن‌ها به‌صورت خودکار ایجاد شده و اینجا نمایش داده می‌شود.'
                : 'When users send /start in the Telegram bot, their accounts, free plans, and credit wallets are created automatically.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کاربر و شناسه تلگرام' : 'Telegram User'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'پلن فعال' : 'Active Plan'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'موجودی اعتبار' : 'Credits'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'درخواست‌ها' : 'Requests'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {users.map((u) => (
                  <tr key={u.userId} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {u.displayName || `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'کاربر تلگرام'}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2">
                        {u.username && (
                          <span dir="ltr" className="inline-block font-mono">
                            @{u.username}
                          </span>
                        )}
                        <span dir="ltr" className="inline-block font-mono">
                          ID:{u.telegramUserId}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-slate-700 dark:text-slate-300">{u.planName}</td>
                    <td className="py-3.5 px-4 tabular-nums">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {formatNumber(Number(u.walletBalance.toFixed(2)), locale)}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {locale === 'fa' ? 'مصرف کل: ' : 'Spent: '}
                        {formatNumber(Number(u.lifetimeSpent.toFixed(2)), locale)}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 tabular-nums">
                      <div className="text-slate-800 dark:text-slate-200">
                        {formatNumber(u.totalRequests, locale)}
                      </div>
                      {u.failedRequests > 0 && (
                        <div className="text-[11px] text-red-600">
                          {formatNumber(u.failedRequests, locale)} {locale === 'fa' ? 'ناموفق' : 'failed'}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusText tone={u.status === 'active' ? 'success' : 'danger'}>
                        {u.status === 'active' ? t.common.active : locale === 'fa' ? 'معلق' : u.status}
                      </StatusText>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button variant="outline" size="sm" onClick={() => void openHistory(u)}>
                          <History className="w-3.5 h-3.5" />
                          <span>{locale === 'fa' ? 'تاریخچه' : 'History'}</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void toggleStatus(u)}
                          className={
                            u.status === 'active'
                              ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30'
                              : 'text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
                          }
                        >
                          {u.status === 'active' ? (
                            <>
                              <Ban className="w-3.5 h-3.5" />
                              <span>{locale === 'fa' ? 'تعلیق' : 'Suspend'}</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>{locale === 'fa' ? 'فعال‌سازی' : 'Activate'}</span>
                            </>
                          )}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      <Modal
        open={Boolean(selectedUser)}
        onClose={() => setSelectedUser(null)}
        title={
          selectedUser
            ? `${locale === 'fa' ? 'تاریخچه مصرف: ' : 'Usage History: '}${selectedUser.displayName || selectedUser.telegramUserId}`
            : ''
        }
        maxWidth="max-w-3xl"
      >
        {historyLoading || !history ? (
          <div className="py-8 text-center text-xs text-slate-500">{t.common.loading}</div>
        ) : (
          <div className="space-y-6 text-xs">
            <div>
              <h3 className="font-semibold text-slate-900 dark:text-slate-100 mb-2">
                {locale === 'fa' ? 'آخرین درخواست‌های هوش مصنوعی' : 'Recent AI Requests'}
              </h3>
              {history.requests.length === 0 ? (
                <p className="text-slate-500">{t.common.noData}</p>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
                  {history.requests.map((r) => (
                    <div key={r.id} className="p-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {r.modelName || r.capability} · {r.providerName || '—'}
                        </div>
                        {r.promptPreview && (
                          <div className="text-slate-500 truncate max-w-md mt-0.5">{r.promptPreview}</div>
                        )}
                      </div>
                      <div className="text-end tabular-nums">
                        <StatusText tone={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>
                          {r.status}
                        </StatusText>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {formatNumber(r.creditsCharged, locale)} {locale === 'fa' ? 'اعتبار' : 'credits'} ·{' '}
                          {formatDateTime(r.createdAt, locale)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="font-semibold text-slate-900 dark:text-slate-100 mb-2">
                {locale === 'fa' ? 'دفترکل تراکنش‌های اعتبار' : 'Credit Wallet Ledger'}
              </h3>
              {history.transactions.length === 0 ? (
                <p className="text-slate-500">{t.common.noData}</p>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
                  {history.transactions.map((tx) => (
                    <div key={tx.id} className="p-3 flex items-center justify-between gap-2">
                      <div>
                        <div className="text-slate-800 dark:text-slate-200">{tx.description || tx.type}</div>
                        <div className="text-[11px] text-slate-500">{formatDateTime(tx.createdAt, locale)}</div>
                      </div>
                      <div className="tabular-nums text-end">
                        <div className={tx.amount >= 0 ? 'text-emerald-700 dark:text-emerald-400 font-semibold' : 'text-red-600 font-semibold'}>
                          {tx.amount >= 0 ? '+' : ''}
                          {formatNumber(Number(tx.amount.toFixed(2)), locale)}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {locale === 'fa' ? 'مانده: ' : 'Bal: '}
                          {formatNumber(Number(tx.balanceAfter.toFixed(2)), locale)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
