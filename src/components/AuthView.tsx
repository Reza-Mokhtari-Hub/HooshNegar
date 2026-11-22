import React, { useState } from 'react';
import { ShieldCheck, Lock, Globe, Moon, Sun, AlertTriangle } from 'lucide-react';
import { apiRequest, setCsrfToken } from '../lib/api';
import { DICTIONARIES, type Locale } from '../i18n';
import { Button, FieldLabel, Input, Surface } from './ui/primitives';
import {
  RuntimeDiagnosticsCard,
  type ClientRuntimeDiagnostics,
} from './RuntimeDiagnosticsCard';

export interface AdminUserSummary {
  id: string;
  email: string;
  fullName: string;
  role: 'super_admin' | 'admin' | 'operator' | 'auditor';
  permissions: string[];
}

interface AuthViewProps {
  needsSetup: boolean;
  locale: Locale;
  dark: boolean;
  onToggleLocale: () => void;
  onToggleDark: () => void;
  warnings: string[];
  startupDiagnostics?: ClientRuntimeDiagnostics | null;
  retryingConnection?: boolean;
  onRetryConnection?: () => Promise<void>;
  onAuthenticated: (admin: AdminUserSummary) => void;
}

export function AuthView({
  needsSetup,
  locale,
  dark,
  onToggleLocale,
  onToggleDark,
  warnings,
  startupDiagnostics,
  retryingConnection = false,
  onRetryConnection,
  onAuthenticated,
}: AuthViewProps) {
  const t = DICTIONARIES[locale];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState(locale === 'fa' ? 'مدیر ارشد سیستم' : 'System Super Admin');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const endpoint = needsSetup ? '/api/auth/setup' : '/api/auth/login';
      const payload = needsSetup
        ? { email: email.trim(), fullName: fullName.trim(), password }
        : { email: email.trim(), password };

      const res = await apiRequest<{ admin: AdminUserSummary; csrfToken: string }>(endpoint, {
        method: 'POST',
        body: payload,
        skipAuthRedirect: true,
      });

      setCsrfToken(res.csrfToken);
      onAuthenticated(res.admin);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در احراز هویت');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950">
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <div className="w-8 h-8 rounded-lg bg-blue-700 text-white flex items-center justify-center">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <span className="text-base font-bold text-slate-900 dark:text-slate-100">{t.appName}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleLocale}
            aria-label={locale === 'fa' ? 'Switch to English' : 'تغییر به فارسی'}
          >
            <Globe className="w-4 h-4" />
            <span>{locale === 'fa' ? 'EN' : 'فا'}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleDark}
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

      <main className="flex-1 flex items-center justify-center p-6">
        {startupDiagnostics ? (
          <div className="w-full max-w-2xl">
            <RuntimeDiagnosticsCard
              diagnostics={startupDiagnostics}
              locale={locale}
              retrying={retryingConnection}
              onRetry={onRetryConnection ?? (async () => {})}
            />
          </div>
        ) : (
          <div className="w-full max-w-md space-y-5">
            <Surface className="p-7">
              <div className="mb-6">
                <p className="text-xs font-medium text-blue-700 dark:text-blue-400">{t.phaseLabel}</p>
                <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 mt-1.5 text-balance">
                  {needsSetup ? t.auth.setupTitle : t.auth.loginTitle}
                </h1>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
                  {needsSetup ? t.auth.setupSubtitle : t.auth.loginSubtitle}
                </p>
              </div>

              {error && (
                <div
                  role="alert"
                  className="mb-5 p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300"
                >
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                {needsSetup && (
                  <div>
                    <FieldLabel htmlFor="admin-fullname" required>
                      {t.auth.fullNameLabel}
                    </FieldLabel>
                    <Input
                      id="admin-fullname"
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      autoComplete="name"
                    />
                  </div>
                )}

                <div>
                  <FieldLabel htmlFor="admin-email" required>
                    {t.auth.emailLabel}
                  </FieldLabel>
                  <Input
                    id="admin-email"
                    type="email"
                    dir="ltr"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@yourdomain.com"
                    autoComplete="email"
                  />
                </div>

                <div>
                  <FieldLabel htmlFor="admin-password" required>
                    {t.auth.passwordLabel}
                  </FieldLabel>
                  <Input
                    id="admin-password"
                    type="password"
                    dir="ltr"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    autoComplete={needsSetup ? 'new-password' : 'current-password'}
                  />
                  {needsSetup && (
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
                      {t.auth.passwordHint}
                    </p>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={submitting}>
                  <Lock className="w-4 h-4" />
                  <span>
                    {submitting
                      ? t.common.loading
                      : needsSetup
                        ? t.auth.createAdminButton
                        : t.auth.signInButton}
                  </span>
                </Button>
              </form>

              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-5 pt-4 border-t border-slate-200 dark:border-slate-800 leading-relaxed">
                {t.auth.securityNote}
              </p>
            </Surface>

            {warnings.length > 0 && (
              <div className="p-4 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 text-xs text-amber-900 dark:text-amber-200 space-y-1.5">
                <div className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{locale === 'fa' ? 'یادداشت پیکربندی محیط اجرا' : 'Runtime Configuration Notice'}</span>
                </div>
                <ul className="space-y-1 ps-6 list-disc text-[11px] leading-relaxed">
                  {warnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
