import React, { useCallback, useEffect, useState } from 'react';
import {
  MessageSquare,
  Sparkles,
  Wallet,
  User,
  Moon,
  Sun,
  Bot,
  Loader2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import {
  getStoredMiniAppToken,
  miniAppRequest,
  setStoredMiniAppToken,
  type MiniAppBootstrap,
  type MiniAppConversation,
  type MiniAppMessage,
  type MiniAppPublicInfo,
} from './miniAppApi';
import {
  getTelegramInitData,
  initTelegramWebAppShell,
  triggerMiniAppHaptic,
} from './telegramSdk';
import { MiniAppLauncherFallback } from './MiniAppLauncherFallback';
import { MiniAppChatTab } from './MiniAppChatTab';
import { MiniAppStudioTab } from './MiniAppStudioTab';
import { MiniAppStoreTab } from './MiniAppStoreTab';
import { MiniAppAccountTab } from './MiniAppAccountTab';

type MiniAppTab = 'chat' | 'studio' | 'store' | 'account';

const TABS: Array<{
  id: MiniAppTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'chat', label: 'گفتگو', icon: MessageSquare },
  { id: 'studio', label: 'استودیو', icon: Sparkles },
  { id: 'store', label: 'فروشگاه', icon: Wallet },
  { id: 'account', label: 'پروفایل', icon: User },
];

export function TelegramMiniApp() {
  const [dark, setDark] = useState(false);
  const [activeTab, setActiveTab] = useState<MiniAppTab>('chat');
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState('');
  const [publicInfo, setPublicInfo] = useState<MiniAppPublicInfo | null>(null);
  const [bootstrap, setBootstrap] = useState<MiniAppBootstrap | null>(null);

  useEffect(() => {
    document.documentElement.lang = 'fa';
    document.documentElement.dir = 'rtl';
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const loadMiniAppSession = useCallback(async () => {
    setLoading(true);
    setError('');
    setAuthRequired(false);

    const shell = initTelegramWebAppShell();
    setDark(shell.colorScheme === 'dark');

    const initData = getTelegramInitData();
    const cachedToken = getStoredMiniAppToken();

    if (!initData && !cachedToken) {
      try {
        const info = await miniAppRequest<MiniAppPublicInfo>('/api/miniapp/public-info');
        setPublicInfo(info);
      } catch {
        setPublicInfo(null);
      }
      setAuthRequired(true);
      setLoading(false);
      return;
    }

    try {
      if (initData) {
        const res = await miniAppRequest<MiniAppBootstrap>('/api/miniapp/auth', {
          method: 'POST',
          body: { initData },
        });
        setStoredMiniAppToken(res.sessionToken);
        setBootstrap(res);
      } else {
        const res = await miniAppRequest<MiniAppBootstrap>('/api/miniapp/bootstrap', {
          sessionToken: cachedToken,
        });
        setBootstrap(res);
      }
    } catch (err) {
      setStoredMiniAppToken(null);
      try {
        const info = await miniAppRequest<MiniAppPublicInfo>('/api/miniapp/public-info');
        setPublicInfo(info);
      } catch {
        setPublicInfo(null);
      }
      if (!initData) {
        setAuthRequired(true);
      } else {
        setError(err instanceof Error ? err.message : 'احراز هویت مینی‌اپ انجام نشد.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMiniAppSession();
  }, [loadMiniAppSession]);

  const refreshBootstrap = useCallback(async () => {
    try {
      const res = await miniAppRequest<MiniAppBootstrap>('/api/miniapp/bootstrap');
      setBootstrap(res);
    } catch {
      // Keep current snapshot
    }
  }, []);

  const handleWalletUpdated = useCallback(
    (wallet: { balance: number; reservedBalance: number }) => {
      setBootstrap((prev) =>
        prev
          ? {
              ...prev,
              wallet: {
                balance: wallet.balance,
                reservedBalance: wallet.reservedBalance,
                available: Math.max(0, wallet.balance - wallet.reservedBalance),
              },
            }
          : prev,
      );
    },
    [],
  );

  const handleConversationChanged = useCallback(
    (
      conversationId: string,
      messages: MiniAppMessage[],
      conversations?: MiniAppConversation[],
    ) => {
      setBootstrap((prev) =>
        prev
          ? {
              ...prev,
              activeConversationId: conversationId,
              messages,
              conversations: conversations ?? prev.conversations,
            }
          : prev,
      );
    },
    [],
  );

  if (loading) {
    return (
      <div
        dir="rtl"
        className="min-h-dvh bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center gap-3 text-xs text-slate-500 dark:text-slate-400"
      >
        <Loader2 className="w-6 h-6 animate-spin text-blue-700 dark:text-blue-400" />
        <span>در حال اتصال امن به ربات هوش‌نگار...</span>
      </div>
    );
  }

  if (authRequired) {
    return <MiniAppLauncherFallback info={publicInfo} />;
  }

  if (!bootstrap) {
    return (
      <div
        dir="rtl"
        className="min-h-dvh bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4"
      >
        <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4 text-center">
          <AlertCircle className="w-8 h-8 text-rose-600 mx-auto" />
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {error || 'امکان برقراری نشست مینی‌اپ وجود ندارد.'}
          </p>
          <button
            type="button"
            onClick={() => void loadMiniAppSession()}
            className="w-full min-h-[44px] px-4 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium flex items-center justify-center gap-2 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            <span>تلاش مجدد</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      dir="rtl"
      className="min-h-dvh bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col"
    >
      {/* Compact Sticky Top Bar (52px; 52+64 = 116px <= 15% of 844px) */}
      <header className="sticky top-0 z-30 h-[52px] bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border-b border-slate-200 dark:border-slate-800 px-3 sm:px-6 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-blue-700 text-white flex items-center justify-center shrink-0">
            <Bot className="w-4 h-4" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
              {bootstrap.bot.displayName}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
              {bootstrap.user.displayName}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setActiveTab('store');
              triggerMiniAppHaptic('tap');
            }}
            className="min-h-[44px] px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5 tabular-nums cursor-pointer"
          >
            <Wallet className="w-3.5 h-3.5 text-blue-700 dark:text-blue-400" />
            <span>{bootstrap.wallet.available.toLocaleString('fa-IR')}</span>
          </button>

          <button
            type="button"
            onClick={() => setDark((prev) => !prev)}
            aria-label={dark ? 'حالت روشن' : 'حالت تاریک'}
            className="min-w-[44px] min-h-[44px] rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center cursor-pointer"
          >
            {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Main Responsive Container (Sidebar Rail on Desktop, Full Content + Bottom Bar on Mobile) */}
      <div className="flex-1 w-full max-w-6xl mx-auto flex gap-4 p-2.5 sm:p-4 pb-20 lg:pb-6">
        <aside className="hidden lg:flex w-56 shrink-0 flex-col gap-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-2.5 self-start sticky top-16">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id);
                  triggerMiniAppHaptic('tap');
                }}
                aria-current={active ? 'page' : undefined}
                className={`min-h-[44px] px-3 rounded-xl text-xs font-medium flex items-center gap-2.5 transition-colors cursor-pointer ${
                  active
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </aside>

        <main className="flex-1 min-w-0">
          {activeTab === 'chat' && (
            <MiniAppChatTab
              models={bootstrap.models}
              selectedModelId={bootstrap.preferences.selectedTextModelId}
              conversations={bootstrap.conversations}
              activeConversationId={bootstrap.activeConversationId}
              messages={bootstrap.messages}
              botDisplayName={bootstrap.bot.displayName}
              onSelectModelId={(modelId) =>
                setBootstrap((prev) =>
                  prev
                    ? {
                        ...prev,
                        preferences: { ...prev.preferences, selectedTextModelId: modelId },
                      }
                    : prev,
                )
              }
              onConversationChanged={handleConversationChanged}
              onWalletUpdated={handleWalletUpdated}
            />
          )}

          {activeTab === 'studio' && (
            <MiniAppStudioTab
              models={bootstrap.models}
              preferences={bootstrap.preferences}
              onWalletUpdated={handleWalletUpdated}
            />
          )}

          {activeTab === 'store' && (
            <MiniAppStoreTab
              bootstrap={bootstrap}
              onRefreshBootstrap={refreshBootstrap}
              onWalletUpdated={handleWalletUpdated}
            />
          )}

          {activeTab === 'account' && (
            <MiniAppAccountTab
              bootstrap={bootstrap}
              onRefreshBootstrap={refreshBootstrap}
            />
          )}
        </main>
      </div>

      {/* Fixed Bottom Navigation on Mobile (64px; 48+64 = 112px <= 15% of 844px) */}
      <nav
        aria-label="ناوبری مینی‌اپ"
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 h-16 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border-t border-slate-200 dark:border-slate-800 grid grid-cols-4 px-2"
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setActiveTab(tab.id);
                triggerMiniAppHaptic('tap');
              }}
              aria-current={active ? 'page' : undefined}
              className={`min-h-[44px] my-auto rounded-xl flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors cursor-pointer ${
                active
                  ? 'text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/50'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
