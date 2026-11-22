import React, { useEffect, useRef, useState } from 'react';
import {
  Send,
  Plus,
  Trash2,
  Copy,
  Check,
  Bot,
  Sparkles,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import {
  miniAppRequest,
  type MiniAppConversation,
  type MiniAppMessage,
  type MiniAppModel,
} from './miniAppApi';
import { triggerMiniAppHaptic } from './telegramSdk';

interface MiniAppChatTabProps {
  models: MiniAppModel[];
  selectedModelId: string | null;
  conversations: MiniAppConversation[];
  activeConversationId: string;
  messages: MiniAppMessage[];
  botDisplayName: string;
  onSelectModelId: (modelId: string) => void;
  onConversationChanged: (
    conversationId: string,
    messages: MiniAppMessage[],
    conversations?: MiniAppConversation[],
  ) => void;
  onWalletUpdated: (wallet: { balance: number; reservedBalance: number }) => void;
}

const STARTER_PROMPTS = [
  'یک متن معرفی حرفه‌ای برای پیج فروش آنلاین بنویس',
  'یک برنامه مطالعاتی ۷ روزه برای یادگیری پایتون بساز',
  'این ایده استارتاپی را تحلیل کن و ۳ نقطه قوت و ریسک آن را بگو',
];

export function MiniAppChatTab({
  models,
  selectedModelId,
  conversations,
  activeConversationId,
  messages,
  botDisplayName,
  onSelectModelId,
  onConversationChanged,
  onWalletUpdated,
}: MiniAppChatTabProps) {
  const chatModels = models.filter(
    (m) => m.capabilities.includes('chat') || m.capabilities.includes('text_generation'),
  );
  const currentModelId =
    (selectedModelId && chatModels.some((m) => m.id === selectedModelId)
      ? selectedModelId
      : chatModels.find((m) => m.isDefault)?.id ?? chatModels[0]?.id) ?? '';

  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingConv, setLoadingConv] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, sending]);

  const handleModelChange = async (modelId: string) => {
    onSelectModelId(modelId);
    triggerMiniAppHaptic('tap');
    try {
      await miniAppRequest('/api/miniapp/preferences', {
        method: 'PATCH',
        body: { selectedTextModelId: modelId },
      });
    } catch {
      // Model still sent directly in /chat payload
    }
  };

  const handleSelectConversation = async (convId: string) => {
    if (!convId || convId === activeConversationId) return;
    setError('');
    setLoadingConv(true);
    triggerMiniAppHaptic('tap');
    try {
      const res = await miniAppRequest<{
        conversation: MiniAppConversation;
        messages: MiniAppMessage[];
      }>(`/api/miniapp/conversations/${encodeURIComponent(convId)}/messages`);
      onConversationChanged(convId, res.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در بارگذاری گفتگو.');
    } finally {
      setLoadingConv(false);
    }
  };

  const handleNewConversation = async () => {
    setError('');
    setLoadingConv(true);
    triggerMiniAppHaptic('tap');
    try {
      const res = await miniAppRequest<{
        conversation: MiniAppConversation;
        messages: MiniAppMessage[];
      }>('/api/miniapp/conversations', {
        method: 'POST',
        body: { title: 'گفتگوی جدید' },
      });
      const updatedList = [
        res.conversation,
        ...conversations.filter((c) => c.id !== res.conversation.id),
      ];
      onConversationChanged(res.conversation.id, res.messages, updatedList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در ایجاد گفتگوی جدید.');
    } finally {
      setLoadingConv(false);
    }
  };

  const handleClearMessages = async () => {
    if (!activeConversationId || messages.length === 0) return;
    setError('');
    setLoadingConv(true);
    triggerMiniAppHaptic('tap');
    try {
      await miniAppRequest(
        `/api/miniapp/conversations/${encodeURIComponent(activeConversationId)}/messages`,
        { method: 'DELETE' },
      );
      const updatedList = conversations.map((c) =>
        c.id === activeConversationId ? { ...c, messageCount: 0 } : c,
      );
      onConversationChanged(activeConversationId, [], updatedList);
      triggerMiniAppHaptic('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در پاک‌سازی پیام‌ها.');
    } finally {
      setLoadingConv(false);
    }
  };

  const handleSend = async (customPrompt?: string) => {
    const text = (customPrompt ?? prompt).trim();
    if (!text || sending) return;

    setError('');
    setSending(true);
    triggerMiniAppHaptic('tap');
    if (!customPrompt) {
      setPrompt('');
    }

    const optimisticUserMsg: MiniAppMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    onConversationChanged(activeConversationId, [...messages, optimisticUserMsg]);

    try {
      const res = await miniAppRequest<{
        ok: boolean;
        conversationId: string;
        messages: MiniAppMessage[];
        wallet: { balance: number; reservedBalance: number };
      }>('/api/miniapp/chat', {
        method: 'POST',
        body: {
          prompt: text,
          conversationId: activeConversationId,
          modelId: currentModelId || null,
        },
      });
      onWalletUpdated(res.wallet);
      const updatedConvs = conversations.map((c) =>
        c.id === res.conversationId
          ? {
              ...c,
              title: c.messageCount === 0 ? text.slice(0, 60) : c.title,
              messageCount: res.messages.length,
            }
          : c,
      );
      onConversationChanged(res.conversationId, res.messages, updatedConvs);
      triggerMiniAppHaptic('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در دریافت پاسخ هوش مصنوعی.');
      triggerMiniAppHaptic('error');
      // Keep optimistic text in input if user typed it
      if (!customPrompt) {
        setPrompt(text);
      }
      onConversationChanged(activeConversationId, messages);
    } finally {
      setSending(false);
    }
  };

  const handleCopy = async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      triggerMiniAppHaptic('tap');
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1600);
    } catch {
      // Ignore clipboard failure
    }
  };

  const selectedModel = chatModels.find((m) => m.id === currentModelId);

  return (
    <div className="flex flex-col h-[calc(100dvh-7.5rem)] lg:h-[calc(100dvh-5.5rem)] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
      {/* Top Toolbar */}
      <div className="shrink-0 p-2.5 sm:p-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex-1 min-w-0">
            <label htmlFor="miniapp-chat-model" className="sr-only">
              انتخاب مدل گفتگو
            </label>
            <select
              id="miniapp-chat-model"
              value={currentModelId}
              onChange={(e) => void handleModelChange(e.target.value)}
              disabled={chatModels.length === 0 || sending}
              className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              {chatModels.length === 0 ? (
                <option value="">مدل متنی فعالی یافت نشد</option>
              ) : (
                chatModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.creditCost} اعتبار
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 sm:hidden">
            <button
              type="button"
              onClick={() => void handleNewConversation()}
              disabled={loadingConv || sending}
              aria-label="گفتگوی جدید"
              title="گفتگوی جدید"
              className="min-h-[44px] min-w-[44px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center justify-center cursor-pointer disabled:opacity-50"
            >
              <Plus className="w-4 h-4 shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => void handleClearMessages()}
              disabled={loadingConv || sending || messages.length === 0}
              aria-label="پاک‌سازی گفتگو"
              title="پاک‌سازی گفتگو"
              className="min-h-[44px] min-w-[44px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-600 dark:text-slate-300 hover:text-rose-700 dark:hover:text-rose-400 flex items-center justify-center cursor-pointer disabled:opacity-40"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex-1 min-w-0">
            <label htmlFor="miniapp-chat-conv" className="sr-only">
              انتخاب گفتگو
            </label>
            <select
              id="miniapp-chat-conv"
              value={activeConversationId}
              onChange={(e) => void handleSelectConversation(e.target.value)}
              disabled={loadingConv || sending}
              className="w-full min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title || 'گفتگو'} ({c.messageCount})
                </option>
              ))}
            </select>
          </div>

          <div className="hidden sm:flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void handleNewConversation()}
              disabled={loadingConv || sending}
              aria-label="گفتگوی جدید"
              title="گفتگوی جدید"
              className="min-h-[44px] min-w-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Plus className="w-4 h-4 shrink-0" />
              <span>جدید</span>
            </button>
            <button
              type="button"
              onClick={() => void handleClearMessages()}
              disabled={loadingConv || sending || messages.length === 0}
              aria-label="پاک‌سازی گفتگو"
              title="پاک‌سازی گفتگو"
              className="min-h-[44px] min-w-[44px] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-slate-600 dark:text-slate-300 hover:text-rose-700 dark:hover:text-rose-400 flex items-center justify-center cursor-pointer disabled:opacity-40"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div
          role="alert"
          className="shrink-0 mx-3 mt-2.5 px-3 py-2 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-200 text-xs flex items-center gap-2"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Messages Feed */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-4 space-y-3">
        {loadingConv ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-500 gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>در حال بارگذاری گفتگو...</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-4 py-6">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-400 flex items-center justify-center">
              <Bot className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                دستیار هوشمند {botDisplayName}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                گفتگوی شما مستقیماً با ربات تلگرام همگام است. پیام خود را بنویسید یا یکی از نمونه‌های زیر را انتخاب کنید.
              </p>
            </div>
            <div className="w-full space-y-2">
              {STARTER_PROMPTS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => void handleSend(item)}
                  className="w-full min-h-[44px] px-3.5 py-2.5 text-right rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 hover:border-blue-400 dark:hover:border-blue-700 text-xs text-slate-700 dark:text-slate-300 flex items-center gap-2 transition-colors cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400 shrink-0" />
                  <span>{item}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === 'user';
            return (
              <div
                key={msg.id}
                className={`flex ${isUser ? 'justify-start' : 'justify-end'}`}
              >
                <div
                  className={`max-w-[88%] sm:max-w-[78%] rounded-2xl px-3.5 py-2.5 text-xs sm:text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
                    isUser
                      ? 'bg-blue-700 text-white'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700'
                  }`}
                >
                  <div dir="auto">{msg.content}</div>
                  {!isUser && (
                    <div className="mt-2 pt-1.5 border-t border-slate-200/70 dark:border-slate-700/70 flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => void handleCopy(msg.id, msg.content)}
                        className="min-h-[44px] px-3 rounded-lg text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-700/70 flex items-center gap-1.5 cursor-pointer"
                      >
                        {copiedId === msg.id ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                            <span>کپی شد</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>کپی</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {sending && (
          <div className="flex justify-end">
            <div className="rounded-2xl px-4 py-3 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-blue-700 dark:text-blue-400" />
              <span>
                در حال پردازش پاسخ
                {selectedModel ? ` با ${selectedModel.name}` : ''}...
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
        className="shrink-0 p-2.5 sm:p-3 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-end gap-2"
      >
        <label htmlFor="miniapp-chat-input" className="sr-only">
          متن پیام
        </label>
        <textarea
          id="miniapp-chat-input"
          rows={1}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder="پیام خود را بنویسید..."
          disabled={sending || chatModels.length === 0}
          className="flex-1 min-h-[44px] max-h-28 px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 resize-none focus:outline-none focus:ring-2 focus:ring-blue-600"
        />
        <button
          type="submit"
          disabled={sending || !prompt.trim() || chatModels.length === 0}
          aria-label="ارسال پیام"
          className="min-h-[44px] min-w-[44px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:bg-slate-200 disabled:text-slate-500 dark:disabled:bg-slate-800 dark:disabled:text-slate-400 text-white flex items-center justify-center gap-1.5 text-xs font-medium transition-colors cursor-pointer disabled:cursor-not-allowed shrink-0"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          <span className="hidden sm:inline">ارسال</span>
        </button>
      </form>
    </div>
  );
}
