export interface TelegramWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface TelegramWebAppInstance {
  initData: string;
  initDataUnsafe?: {
    user?: TelegramWebAppUser;
    start_param?: string;
  };
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
  platform?: string;
  isExpanded?: boolean;
  ready: () => void;
  expand: () => void;
  close: () => void;
  openTelegramLink?: (url: string) => void;
  openInvoice?: (url: string, callback?: (status: string) => void) => void;
  showAlert?: (message: string) => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
    selectionChanged: () => void;
  };
  isVersionAtLeast?: (version: string) => boolean;
  onEvent?: (eventType: string, callback: () => void) => void;
  offEvent?: (eventType: string, callback: () => void) => void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebAppInstance;
    };
  }
}

export function getTelegramWebApp(): TelegramWebAppInstance | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

export function isMiniAppEntryRoute(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.toLowerCase();
  if (path === '/miniapp' || path.startsWith('/miniapp/')) {
    return true;
  }
  const search = new URLSearchParams(window.location.search);
  if (search.get('miniapp') === '1' || search.has('tgWebAppStartParam')) {
    return true;
  }
  const tg = getTelegramWebApp();
  return Boolean(tg?.initData && tg.initData.trim().length > 0);
}

export function getTelegramInitData(): string {
  const tg = getTelegramWebApp();
  if (tg?.initData && tg.initData.trim().length > 0) {
    return tg.initData.trim();
  }
  if (typeof window !== 'undefined') {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const hashParams = new URLSearchParams(hash);
    const fromHash = hashParams.get('tgWebAppData');
    if (fromHash && fromHash.trim().length > 0) {
      return fromHash.trim();
    }
  }
  return '';
}

export function initTelegramWebAppShell(): {
  hasTelegramInitData: boolean;
  colorScheme: 'light' | 'dark';
} {
  const tg = getTelegramWebApp();
  if (tg) {
    try {
      tg.ready();
      tg.expand();
    } catch {
      // Ignore outside Telegram
    }
  }
  const colorScheme: 'light' | 'dark' =
    tg?.colorScheme === 'dark' ||
    (typeof window !== 'undefined' &&
      !tg?.colorScheme &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches)
      ? 'dark'
      : 'light';

  return {
    hasTelegramInitData: getTelegramInitData().length > 0,
    colorScheme,
  };
}

export function triggerMiniAppHaptic(type: 'tap' | 'success' | 'error'): void {
  const tg = getTelegramWebApp();
  const hf = tg?.HapticFeedback;
  if (!hf) return;
  if (typeof tg?.isVersionAtLeast === 'function' && !tg.isVersionAtLeast('6.1')) {
    return;
  }
  try {
    if (type === 'tap') {
      hf.impactOccurred('light');
    } else {
      hf.notificationOccurred(type);
    }
  } catch {
    // Ignore unsupported platform
  }
}

export function openTelegramStarsInvoice(
  invoiceUrl: string,
  onResult: (status: 'paid' | 'cancelled' | 'failed' | 'pending' | 'external') => void,
): void {
  const tg = getTelegramWebApp();
  if (tg?.openInvoice) {
    try {
      tg.openInvoice(invoiceUrl, (status) => {
        if (status === 'paid' || status === 'cancelled' || status === 'failed' || status === 'pending') {
          onResult(status);
        } else {
          onResult('pending');
        }
      });
      return;
    } catch {
      // Fall through to link navigation
    }
  }
  window.location.href = invoiceUrl;
  onResult('external');
}
