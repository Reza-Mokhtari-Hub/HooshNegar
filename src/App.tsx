import React, { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Cpu,
  Boxes,
  KeyRound,
  Send,
  CreditCard,
  Users,
  Receipt,
  Gift,
  BarChart3,
  Settings,
  ShieldCheck,
  LogOut,
  Menu,
  X,
  Globe,
  Moon,
  Sun,
  Radio,
  UserCheck,
  MessageSquare,
  Activity,
  Layers,
  Gauge,
  PieChart,
  AlertTriangle,
  Wallet,
  LifeBuoy,
  Bell,
} from 'lucide-react';
import { ApiError, apiRequest, setCsrfToken, setUnauthorizedHandler } from './lib/api';
import './lib/firebase';
import { DICTIONARIES, type Locale, type NavSectionId } from './i18n';
import { AuthView, type AdminUserSummary } from './components/AuthView';
import type { ClientRuntimeDiagnostics } from './components/RuntimeDiagnosticsCard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Button } from './components/ui/primitives';
import { DashboardSection } from './components/sections/DashboardSection';
import { ProvidersSection } from './components/sections/ProvidersSection';
import { ModelsSection } from './components/sections/ModelsSection';
import { CredentialsSection } from './components/sections/CredentialsSection';
import { TelegramSection } from './components/sections/TelegramSection';
import { BotMonitorSection } from './components/sections/BotMonitorSection';
import { ConnectedUsersSection } from './components/sections/ConnectedUsersSection';
import { ConversationsSection } from './components/sections/ConversationsSection';
import {
  AIRequestsSection,
  FailedRequestsSection,
  GenerationJobsSection,
} from './components/sections/RequestsJobsSection';
import {
  ModelUsageSection,
  ProviderPerformanceSection,
} from './components/sections/PerformanceUsageSection';
import { PlansSection } from './components/sections/PlansSection';
import { FinanceSection } from './components/sections/FinanceSection';
import { UsersSection } from './components/sections/UsersSection';
import { TransactionsSection } from './components/sections/TransactionsSection';
import { ReferralsSection } from './components/sections/ReferralsSection';
import { SupportSection } from './components/sections/SupportSection';
import { NotificationsSection } from './components/sections/NotificationsSection';
import { AnalyticsSection } from './components/sections/AnalyticsSection';
import { SettingsSection } from './components/sections/SettingsSection';
import { SecuritySection } from './components/sections/SecuritySection';

interface NavItem {
  id: NavSectionId;
  icon: React.ComponentType<{ className?: string }>;
  group: 'core' | 'ops' | 'commerce' | 'system';
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', icon: LayoutDashboard, group: 'core' },
  { id: 'providers', icon: Cpu, group: 'core' },
  { id: 'models', icon: Boxes, group: 'core' },
  { id: 'credentials', icon: KeyRound, group: 'core' },
  { id: 'telegram', icon: Send, group: 'core' },
  { id: 'botMonitor', icon: Radio, group: 'ops' },
  { id: 'connectedUsers', icon: UserCheck, group: 'ops' },
  { id: 'conversations', icon: MessageSquare, group: 'ops' },
  { id: 'aiRequests', icon: Activity, group: 'ops' },
  { id: 'generationJobs', icon: Layers, group: 'ops' },
  { id: 'providerPerformance', icon: Gauge, group: 'ops' },
  { id: 'modelUsage', icon: PieChart, group: 'ops' },
  { id: 'failedRequests', icon: AlertTriangle, group: 'ops' },
  { id: 'plans', icon: CreditCard, group: 'commerce' },
  { id: 'finance', icon: Wallet, group: 'commerce' },
  { id: 'users', icon: Users, group: 'commerce' },
  { id: 'transactions', icon: Receipt, group: 'commerce' },
  { id: 'referrals', icon: Gift, group: 'commerce' },
  { id: 'support', icon: LifeBuoy, group: 'commerce' },
  { id: 'notifications', icon: Bell, group: 'commerce' },
  { id: 'analytics', icon: BarChart3, group: 'commerce' },
  { id: 'settings', icon: Settings, group: 'system' },
  { id: 'security', icon: ShieldCheck, group: 'system' },
];

export default function App() {
  const [locale, setLocale] = useState<Locale>('fa');
  const [dark, setDark] = useState(false);
  const [appNameOverride, setAppNameOverride] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<NavSectionId>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [authChecked, setAuthChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [envWarnings, setEnvWarnings] = useState<string[]>([]);
  const [admin, setAdmin] = useState<AdminUserSummary | null>(null);
  const [startupDiagnostics, setStartupDiagnostics] = useState<ClientRuntimeDiagnostics | null>(null);
  const [retryingConnection, setRetryingConnection] = useState(false);

  const t = DICTIONARIES[locale];
  const displayAppName = appNameOverride || t.appName;

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'fa' ? 'rtl' : 'ltr';
  }, [locale]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const checkAuth = useCallback(async () => {
    setRetryingConnection(true);
    try {
      const status = await apiRequest<{
        needsSetup: boolean;
        warnings: string[];
      }>('/api/auth/status', { skipAuthRedirect: true });
      setStartupDiagnostics(null);
      setNeedsSetup(status.needsSetup);
      setEnvWarnings(status.warnings ?? []);

      if (!status.needsSetup) {
        try {
          const me = await apiRequest<{ admin: AdminUserSummary; csrfToken: string }>(
            '/api/auth/me',
            { skipAuthRedirect: true },
          );
          setCsrfToken(me.csrfToken);
          setAdmin(me.admin);
        } catch {
          setAdmin(null);
          setCsrfToken(null);
        }
      }
    } catch (err) {
      setAdmin(null);
      const fromPayload =
        err instanceof ApiError && err.payload && typeof err.payload.diagnostics === 'object'
          ? (err.payload.diagnostics as ClientRuntimeDiagnostics)
          : null;

      if (fromPayload) {
        setStartupDiagnostics(fromPayload);
      } else {
        try {
          const health = await apiRequest<{ diagnostics?: ClientRuntimeDiagnostics }>(
            '/api/health?db=1',
            { skipAuthRedirect: true },
          );
          if (health.diagnostics) {
            setStartupDiagnostics(health.diagnostics);
          }
        } catch {
          setStartupDiagnostics({
            ready: false,
            runtime: 'cloudflare_workers',
            databaseMode: 'cloudflare_durable_object',
            checks: [],
            missingRequiredVars: [],
            invalidVars: [],
            boundEnvKeys: [],
            probableCause:
              err instanceof Error
                ? `ارتباط با سرور API برقرار نشد: ${err.message}`
                : 'ارتباط با سرور API برقرار نشد.',
            fixSteps: ['اتصال اینترنت و وضعیت آنلاین بودن Worker را بررسی کرده و دوباره تلاش کنید.'],
          });
        }
      }
    } finally {
      setRetryingConnection(false);
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAdmin(null);
      setCsrfToken(null);
    });
    void checkAuth();
    return () => setUnauthorizedHandler(null);
  }, [checkAuth]);

  const handleLogout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST', skipAuthRedirect: true });
    } catch {
      // Clear client state regardless
    }
    setCsrfToken(null);
    setAdmin(null);
    setNeedsSetup(false);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-xs text-slate-500">
        {t.common.loading}
      </div>
    );
  }

  if (!admin) {
    return (
      <ErrorBoundary>
        <AuthView
          needsSetup={needsSetup}
          locale={locale}
          dark={dark}
          onToggleLocale={() => setLocale((prev) => (prev === 'fa' ? 'en' : 'fa'))}
          onToggleDark={() => setDark((prev) => !prev)}
          warnings={envWarnings}
          startupDiagnostics={startupDiagnostics}
          retryingConnection={retryingConnection}
          onRetryConnection={checkAuth}
          onAuthenticated={(authenticatedAdmin) => {
            setNeedsSetup(false);
            setAdmin(authenticatedAdmin);
            setActiveSection('dashboard');
          }}
        />
      </ErrorBoundary>
    );
  }

  const renderSection = () => {
    switch (activeSection) {
      case 'dashboard':
        return <DashboardSection locale={locale} onNavigate={setActiveSection} />;
      case 'providers':
        return <ProvidersSection locale={locale} />;
      case 'models':
        return <ModelsSection locale={locale} />;
      case 'credentials':
        return <CredentialsSection locale={locale} />;
      case 'telegram':
        return <TelegramSection locale={locale} />;
      case 'botMonitor':
        return <BotMonitorSection locale={locale} />;
      case 'connectedUsers':
        return <ConnectedUsersSection locale={locale} />;
      case 'conversations':
        return <ConversationsSection locale={locale} />;
      case 'aiRequests':
        return <AIRequestsSection locale={locale} />;
      case 'generationJobs':
        return <GenerationJobsSection locale={locale} />;
      case 'providerPerformance':
        return <ProviderPerformanceSection locale={locale} />;
      case 'modelUsage':
        return <ModelUsageSection locale={locale} />;
      case 'failedRequests':
        return <FailedRequestsSection locale={locale} />;
      case 'plans':
        return <PlansSection locale={locale} />;
      case 'finance':
        return <FinanceSection locale={locale} />;
      case 'users':
        return <UsersSection locale={locale} adminRole={admin.role} />;
      case 'transactions':
        return <TransactionsSection locale={locale} />;
      case 'referrals':
        return <ReferralsSection locale={locale} />;
      case 'support':
        return <SupportSection locale={locale} />;
      case 'notifications':
        return <NotificationsSection locale={locale} />;
      case 'analytics':
        return <AnalyticsSection locale={locale} />;
      case 'settings':
        return <SettingsSection locale={locale} onAppNameUpdated={setAppNameOverride} />;
      case 'security':
        return <SecuritySection locale={locale} />;
      default:
        return <DashboardSection locale={locale} onNavigate={setActiveSection} />;
    }
  };

  const SidebarContent = (
    <div className="flex flex-col h-full">
      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-blue-700 text-white flex items-center justify-center shrink-0">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <span className="text-base font-bold text-slate-900 dark:text-slate-100 truncate">
            {displayAppName}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          aria-label={t.common.close}
          className="lg:hidden p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav aria-label={locale === 'fa' ? 'منوی اصلی مدیریت' : 'Main Admin Navigation'} className="flex-1 overflow-y-auto p-3 space-y-5">
        {(['core', 'ops', 'commerce', 'system'] as const).map((group) => {
          const items = NAV_ITEMS.filter((i) => i.group === group);
          const groupTitle =
            group === 'core'
              ? locale === 'fa'
                ? 'هسته هوش مصنوعی و ربات'
                : 'AI Core & Bot'
              : group === 'ops'
                ? locale === 'fa'
                  ? 'پایش ربات و موتور هوش مصنوعی'
                  : 'Bot & AI Operations'
                : group === 'commerce'
                  ? locale === 'fa'
                    ? 'اشتراک، کاربران و تحلیل'
                    : 'Plans, Users & Analytics'
                  : locale === 'fa'
                    ? 'تنظیمات و امنیت'
                    : 'System & Security';

          return (
            <div key={group}>
              <div className="px-3 mb-1.5 text-[11px] font-medium text-slate-400 dark:text-slate-500">
                {groupTitle}
              </div>
              <div className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = activeSection === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveSection(item.id);
                        setMobileMenuOpen(false);
                      }}
                      aria-current={active ? 'page' : undefined}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                        active
                          ? 'bg-blue-50 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300'
                          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-slate-100'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate">{t.nav[item.id]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="p-4 border-t border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
            {admin.fullName}
          </span>
          <span
            dir="ltr"
            className="text-[10px] font-mono text-blue-700 dark:text-blue-400 shrink-0"
          >
            {admin.role}
          </span>
        </div>
        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate mt-1">
          <span dir="ltr" className="inline-block">
            {admin.email}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleLogout}
          className="w-full mt-3"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>{t.common.logout}</span>
        </Button>
      </div>
    </div>
  );

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:block w-64 shrink-0 bg-white dark:bg-slate-900 border-e border-slate-200 dark:border-slate-800 sticky top-0 h-screen">
          {SidebarContent}
        </aside>

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 lg:hidden flex">
            <div
              className="fixed inset-0 bg-slate-950/50"
              onClick={() => setMobileMenuOpen(false)}
              aria-hidden="true"
            />
            <aside className="relative z-10 w-72 max-w-[85vw] bg-white dark:bg-slate-900 h-full shadow-xl">
              {SidebarContent}
            </aside>
          </div>
        )}

        {/* Main Workspace */}
        <div className="flex-1 min-w-0 flex flex-col">
          <header className="sticky top-0 z-30 h-14 px-4 sm:px-6 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                aria-label={locale === 'fa' ? 'باز کردن منو' : 'Open menu'}
                className="lg:hidden p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <Menu className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 truncate">
                <span className="font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap">
                  {displayAppName}
                </span>
                <span aria-hidden="true">/</span>
                <span className="text-slate-900 dark:text-slate-100 font-semibold truncate">
                  {t.nav[activeSection]}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocale((prev) => (prev === 'fa' ? 'en' : 'fa'))}
                aria-label={locale === 'fa' ? 'Switch to English' : 'تغییر زبان به فارسی'}
              >
                <Globe className="w-4 h-4" />
                <span>{locale === 'fa' ? 'EN' : 'فا'}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDark((prev) => !prev)}
                aria-label={
                  locale === 'fa'
                    ? dark
                      ? 'حالت روشن'
                      : 'حالت تاریک'
                    : dark
                      ? 'Light mode'
                      : 'Dark mode'
                }
              >
                {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </Button>
            </div>
          </header>

          <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1400px] w-full mx-auto">
            {renderSection()}
          </main>
        </div>
      </div>
    </ErrorBoundary>
  );
}
