import React, { useCallback, useEffect, useState } from 'react';
import { MessageSquareReply, RefreshCw } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, type Locale } from '../../i18n';
import {
  SUPPORT_CATEGORIES,
  TICKET_STATUSES,
  type TicketStatus,
} from '../../shared/validation';
import {
  Button,
  EmptyState,
  FieldLabel,
  Modal,
  Select,
  StatusText,
  Surface,
  TableSkeleton,
  Textarea,
} from '../ui/primitives';

interface SupportTicketRow {
  id: string;
  userId: string;
  userDisplayName: string | null;
  telegramUsername: string | null;
  telegramChatId: number | null;
  category: string;
  relatedPaymentId: string | null;
  relatedOrderNumber: string | null;
  relatedRequestId: string | null;
  subject: string;
  message: string;
  adminReply: string | null;
  repliedAt: string | null;
  status: TicketStatus;
  priority: string;
  resolvedAt: string | null;
  createdAt: string;
}

const CATEGORY_LABELS: Record<string, { fa: string; en: string }> = {
  general: { fa: 'عمومی', en: 'General' },
  payment: { fa: 'پرداخت و اشتراک', en: 'Payment & Billing' },
  failed_request: { fa: 'درخواست ناموفق AI', en: 'Failed AI Request' },
  refund: { fa: 'درخواست بازپرداخت', en: 'Refund Request' },
};

export function SupportSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [tickets, setTickets] = useState<SupportTicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [replyTarget, setReplyTarget] = useState<SupportTicketRow | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyStatus, setReplyStatus] = useState<TicketStatus>('resolved');
  const [notifyTelegram, setNotifyTelegram] = useState(true);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (statusFilter !== 'all') qs.set('status', statusFilter);
      if (categoryFilter !== 'all') qs.set('category', categoryFilter);
      const res = await apiRequest<{ tickets: SupportTicketRow[] }>(
        `/api/support/tickets${qs.toString() ? `?${qs.toString()}` : ''}`,
      );
      setTickets(res.tickets);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در دریافت تیکت‌ها' });
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyTarget) return;
    setSending(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ telegramNotified: boolean }>(
        `/api/support/tickets/${replyTarget.id}/reply`,
        {
          method: 'POST',
          body: {
            reply: replyText.trim(),
            status: replyStatus,
            notifyTelegram,
          },
        },
      );
      setReplyTarget(null);
      setReplyText('');
      setFeedback({
        tone: 'success',
        text:
          locale === 'fa'
            ? `پاسخ تیکت ذخیره شد.${res.telegramNotified ? ' پیام در تلگرام برای کاربر ارسال شد.' : ''}`
            : `Ticket reply saved.${res.telegramNotified ? ' Sent to user via Telegram.' : ''}`,
      });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ارسال پاسخ' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.support}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'مدیریت تیکت‌های پشتیبانی کاربران (دسته‌بندی پرداخت، بازپرداخت /paysupport و خطای AI) و ارسال پاسخ مستقیم به تلگرام.'
              : 'Manage categorized user support tickets (payment, /paysupport refund, failed AI requests) with direct Telegram reply delivery.'}
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

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full sm:w-48">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t.common.status}>
            <option value="all">{locale === 'fa' ? 'همه وضعیت‌ها' : 'All Statuses'}</option>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-52">
          <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} aria-label="Category">
            <option value="all">{locale === 'fa' ? 'همه دسته‌ها' : 'All Categories'}</option>
            {SUPPORT_CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]?.[locale] ?? c}</option>
            ))}
          </Select>
        </div>
      </div>

      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={5} />
        ) : tickets.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'تیکت پشتیبانی ثبت نشده است' : 'No support tickets'}
            description={
              locale === 'fa'
                ? 'تیکت‌هایی که کاربران از طریق دستور /paysupport یا دکمه پشتیبانی در ربات تلگرام ارسال کنند اینجا نمایش داده می‌شوند.'
                : 'Tickets submitted via /paysupport or the Support menu inside Telegram will appear here.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کاربر و دسته' : 'User & Category'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'موضوع و متن تیکت' : 'Subject & Message'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'ارجاع مرتبط' : 'Linked Ref'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {tickets.map((tk) => (
                  <tr key={tk.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 align-top">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {tk.userDisplayName || tk.userId.slice(0, 8)}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {CATEGORY_LABELS[tk.category]?.[locale] ?? tk.category}
                        {tk.telegramUsername && (
                          <span dir="ltr" className="ms-1.5 font-mono inline-block">@{tk.telegramUsername}</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 max-w-md">
                      <div className="font-semibold text-slate-800 dark:text-slate-200">{tk.subject}</div>
                      <div className="text-slate-600 dark:text-slate-400 mt-1 whitespace-pre-wrap leading-relaxed">
                        {tk.message}
                      </div>
                      {tk.adminReply && (
                        <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800 text-[11px] text-blue-800 dark:text-blue-300">
                          <span className="font-semibold">{locale === 'fa' ? 'پاسخ مدیر:' : 'Admin Reply:'}</span>{' '}
                          {tk.adminReply}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-[11px] text-slate-500">
                      {tk.relatedOrderNumber ? (
                        <span dir="ltr" className="inline-block">{tk.relatedOrderNumber}</span>
                      ) : tk.relatedRequestId ? (
                        <span dir="ltr" className="inline-block">req:{tk.relatedRequestId.slice(0, 8)}</span>
                      ) : (
                        '—'
                      )}
                      <div className="font-sans text-[11px] mt-1">{formatDateTime(tk.createdAt, locale)}</div>
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusText
                        tone={
                          tk.status === 'resolved' || tk.status === 'closed'
                            ? 'success'
                            : tk.status === 'open'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {tk.status}
                      </StatusText>
                    </td>
                    <td className="py-3.5 px-4 text-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setReplyTarget(tk);
                          setReplyText(tk.adminReply ?? '');
                          setReplyStatus('resolved');
                          setNotifyTelegram(true);
                        }}
                      >
                        <MessageSquareReply className="w-3.5 h-3.5" />
                        <span>{locale === 'fa' ? 'پاسخ' : 'Reply'}</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      <Modal
        open={Boolean(replyTarget)}
        onClose={() => setReplyTarget(null)}
        maxWidth="max-w-lg"
        title={locale === 'fa' ? 'پاسخ به تیکت پشتیبانی' : 'Reply to Support Ticket'}
        description={replyTarget ? `${replyTarget.subject} (${replyTarget.userDisplayName ?? replyTarget.userId.slice(0, 8)})` : undefined}
      >
        <form onSubmit={handleReply} className="space-y-4">
          {replyTarget && (
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300">
              {replyTarget.message}
            </div>
          )}
          <div>
            <FieldLabel htmlFor="tk-reply" required>{locale === 'fa' ? 'متن پاسخ' : 'Reply Message'}</FieldLabel>
            <Textarea
              id="tk-reply"
              rows={4}
              required
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
            />
          </div>
          <div>
            <FieldLabel htmlFor="tk-status">{locale === 'fa' ? 'وضعیت جدید تیکت' : 'New Status'}</FieldLabel>
            <Select
              id="tk-status"
              value={replyStatus}
              onChange={(e) => setReplyStatus(e.target.value as TicketStatus)}
            >
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={notifyTelegram}
              onChange={(e) => setNotifyTelegram(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-blue-700"
            />
            <span>{locale === 'fa' ? 'ارسال خودکار متن پاسخ به تلگرام کاربر' : 'Send reply directly to user via Telegram'}</span>
          </label>
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <Button variant="outline" onClick={() => setReplyTarget(null)}>{t.common.cancel}</Button>
            <Button type="submit" disabled={sending}>
              {sending ? t.common.saving : locale === 'fa' ? 'ارسال پاسخ' : 'Send Reply'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
