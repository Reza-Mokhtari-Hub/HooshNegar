import { getTelegramInitData } from './telegramSdk';

export interface MiniAppModel {
  id: string;
  name: string;
  modelIdentifier: string;
  category: string;
  description: string;
  providerId: string;
  providerName: string;
  creditCost: number;
  isDefault: boolean;
  capabilities: string[];
}

export interface MiniAppMessage {
  id: string;
  role: 'user' | 'assistant' | string;
  content: string;
  createdAt: string;
}

export interface MiniAppConversation {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
}

export interface MiniAppPlan {
  id: string;
  name: string;
  tier: string;
  description: string;
  starsPrice: number;
  durationDays: number;
  creditAllocation: number;
  dailyRequestLimit: number;
  isRecurringStars: boolean;
  features: string[];
}

export interface MiniAppCreditPackage {
  id: string;
  name: string;
  description: string;
  creditsAmount: number;
  bonusCredits: number;
  starsPrice: number;
}

export interface MiniAppPaymentRecord {
  id: string;
  orderNumber: string | null;
  paymentType: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
}

export interface MiniAppBootstrap {
  sessionToken: string;
  user: {
    id: string;
    locale: 'fa' | 'en';
    status: string;
    telegramUserId: number;
    username: string | null;
    displayName: string;
    isPremiumTelegram: boolean;
    isNewUser: boolean;
    referralApplied: boolean;
  };
  wallet: {
    balance: number;
    reservedBalance: number;
    available: number;
  };
  plan: {
    id: string;
    name: string;
    tier: string;
    dailyRequestLimit: number;
    monthlyRequestLimit: number;
    imageGenerationLimit: number;
    audioGenerationLimit: number;
    videoGenerationLimit: number;
    maxFileSizeMb: number;
    priorityQueue: boolean;
  } | null;
  subscription: {
    id: string;
    status: string;
    endsAt: string;
    autoRenew: boolean;
  } | null;
  usage: {
    todayRequests: number;
    monthRequests: number;
    monthImages: number;
    monthVideos: number;
    monthAudio: number;
    referralCode: string | null;
    referredCount: number;
  };
  models: MiniAppModel[];
  preferences: {
    locale: 'fa' | 'en';
    systemPrompt: string;
    selectedTextModelId: string | null;
    selectedImageModelId: string | null;
    selectedAudioModelId: string | null;
    selectedVideoModelId: string | null;
    selectedDocumentModelId: string | null;
  };
  activeConversationId: string;
  conversations: MiniAppConversation[];
  messages: MiniAppMessage[];
  plans: MiniAppPlan[];
  creditPackages: MiniAppCreditPackage[];
  recentPayments: MiniAppPaymentRecord[];
  referralDashboard: {
    referralCode: string | null;
    totalInvited: number;
    qualifiedCount: number;
    pendingCount: number;
    earnedCredits: number;
    earnedDays: number;
  };
  bot: {
    username: string;
    displayName: string;
    supportUsername: string;
    welcomeMessage: string;
    isActive: boolean;
  };
}

export interface MiniAppPublicInfo {
  botUsername: string;
  botDisplayName: string;
  supportUsername: string;
  welcomeMessage: string;
  botReady: boolean;
}

const SESSION_STORAGE_KEY = 'hn_miniapp_token';

export function getStoredMiniAppToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredMiniAppToken(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(SESSION_STORAGE_KEY, token);
    } else {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export async function miniAppRequest<T>(
  path: string,
  options?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    sessionToken?: string | null;
  },
): Promise<T> {
  const headers: Record<string, string> = {};
  const initData = getTelegramInitData();
  if (initData) {
    headers['X-Telegram-Init-Data'] = initData;
  }
  const token = options?.sessionToken ?? getStoredMiniAppToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, {
    method: options?.method ?? 'GET',
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errMsg = typeof json.error === 'string' ? json.error : `خطای ارتباط با سرور (${res.status})`;
    throw new Error(errMsg);
  }
  return json as T;
}
