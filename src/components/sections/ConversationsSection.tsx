import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, MessageSquare } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import { Button, EmptyState, Modal, Surface, TableSkeleton } from '../ui/primitives';

interface ConversationItem {
  id: string;
  userId: string;
  title: string;
  status: string;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  modelName: string | null;
  telegramUsername: string | null;
  telegramUserId: number | null;
  displayName: string | null;
}

interface MessageItem {
  id: string;
  role: string;
  content: string;
  tokenCount: number;
  createdAt: string;
}

export function ConversationsSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ConversationItem | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ conversations: ConversationItem[] }>('/api/monitor/conversations');
      setItems(res.conversations);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openThread = async (conv: ConversationItem) => {
    setSelected(conv);
    setMessages([]);
    setLoadingMsgs(true);
    try {
      const res = await apiRequest<{ messages: MessageItem[] }>(
        `/api/monitor/conversations/${conv.id}/messages`,
      );
      setMessages(res.messages);
    } finally {
      setLoadingMsgs(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {t.nav.conversations}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'مشاهده رشته‌های گفتگوی کاربران با مدل‌های هوش مصنوعی در ربات تلگرام و بررسی پیام‌ها.'
              : 'Inspect multi-turn Telegram AI conversation threads and message transcripts.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>{t.common.refresh}</span>
        </Button>
      </div>

      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={5} />
        ) : items.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'هنوز گفتگویی ثبت نشده است' : 'No conversations logged yet'}
            description={
              locale === 'fa'
                ? 'پس از شروع گفتگوهای متنی کاربران در تلگرام، تاریخچه کامل هر رشته در اینجا در دسترس خواهد بود.'
                : 'Conversation threads will appear here as soon as users chat with the bot.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'عنوان گفتگو' : 'Title'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کاربر' : 'User'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'مدل' : 'Model'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'تعداد پیام' : 'Messages'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'آخرین فعالیت' : 'Last Active'}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {items.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="py-3.5 px-4 font-medium text-slate-900 dark:text-slate-100 max-w-xs truncate">
                      {c.title}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="text-slate-800 dark:text-slate-200">{c.displayName || 'کاربر'}</div>
                      {c.telegramUsername && (
                        <span dir="ltr" className="inline-block font-mono text-[11px] text-slate-500">
                          @{c.telegramUsername}
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-slate-600 dark:text-slate-400">
                      {c.modelName || '—'}
                    </td>
                    <td className="py-3.5 px-4 tabular-nums">{formatNumber(c.messageCount, locale)}</td>
                    <td className="py-3.5 px-4 text-slate-500 tabular-nums">
                      {formatDateTime(c.lastMessageAt ?? c.createdAt, locale)}
                    </td>
                    <td className="py-3.5 px-4 text-end">
                      <Button variant="outline" size="sm" onClick={() => void openThread(c)}>
                        <MessageSquare className="w-3.5 h-3.5" />
                        <span>{locale === 'fa' ? 'مشاهده پیام‌ها' : 'Inspect'}</span>
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
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.title ?? ''}
        maxWidth="max-w-3xl"
      >
        {loadingMsgs ? (
          <div className="py-8 text-center text-xs text-slate-500">{t.common.loading}</div>
        ) : messages.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500">{t.common.noData}</div>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`p-3.5 rounded-xl border text-xs leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-blue-50/60 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900'
                    : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1.5">
                  <span className="font-semibold text-slate-700 dark:text-slate-300">
                    {m.role === 'user'
                      ? locale === 'fa'
                        ? 'کاربر'
                        : 'User'
                      : locale === 'fa'
                        ? 'دستیار هوش مصنوعی'
                        : 'Assistant'}
                  </span>
                  <span className="tabular-nums">{formatDateTime(m.createdAt, locale)}</span>
                </div>
                <div className="whitespace-pre-wrap text-slate-800 dark:text-slate-200">{m.content}</div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
