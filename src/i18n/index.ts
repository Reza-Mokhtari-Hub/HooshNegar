import type { CapabilityType, ModelCategory, PlanTier, ProviderType } from '../shared/validation';

export type Locale = 'fa' | 'en';

export type NavSectionId =
  | 'dashboard'
  | 'providers'
  | 'models'
  | 'credentials'
  | 'telegram'
  | 'botMonitor'
  | 'connectedUsers'
  | 'conversations'
  | 'aiRequests'
  | 'generationJobs'
  | 'providerPerformance'
  | 'modelUsage'
  | 'failedRequests'
  | 'plans'
  | 'finance'
  | 'users'
  | 'transactions'
  | 'referrals'
  | 'support'
  | 'notifications'
  | 'analytics'
  | 'settings'
  | 'security';

export interface Dictionary {
  appName: string;
  phaseLabel: string;
  nav: Record<NavSectionId, string>;
  common: {
    save: string;
    saving: string;
    cancel: string;
    create: string;
    edit: string;
    delete: string;
    refresh: string;
    searchPlaceholder: string;
    active: string;
    inactive: string;
    enabled: string;
    disabled: string;
    all: string;
    loading: string;
    noData: string;
    actions: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    logout: string;
    confirmDelete: string;
    testConnection: string;
    testing: string;
    rotateKey: string;
    close: string;
    yes: string;
    no: string;
  };
  auth: {
    loginTitle: string;
    loginSubtitle: string;
    setupTitle: string;
    setupSubtitle: string;
    emailLabel: string;
    passwordLabel: string;
    fullNameLabel: string;
    signInButton: string;
    createAdminButton: string;
    passwordHint: string;
    securityNote: string;
  };
  providerTypes: Record<ProviderType, string>;
  connectionStatuses: Record<'untested' | 'connected' | 'degraded' | 'failed', string>;
  modelCategories: Record<ModelCategory, string>;
  capabilities: Record<CapabilityType, string>;
  planTiers: Record<PlanTier, string>;
}

export const DICTIONARIES: Record<Locale, Dictionary> = {
  fa: {
    appName: 'هوش‌نگار',
    phaseLabel: 'فاز ۳ · اشتراک، استارز و مالی',
    nav: {
      dashboard: 'داشبورد',
      providers: 'ارائه‌دهندگان هوش مصنوعی',
      models: 'مدل‌های هوش مصنوعی',
      credentials: 'کلیدها و اعتبارنامه‌ها',
      telegram: 'تنظیمات ربات تلگرام',
      botMonitor: 'پایش ربات تلگرام',
      connectedUsers: 'کاربران متصل تلگرام',
      conversations: 'گزارش گفتگوها',
      aiRequests: 'درخواست‌های هوش مصنوعی',
      generationJobs: 'صف کارهای تولید',
      providerPerformance: 'عملکرد ارائه‌دهندگان',
      modelUsage: 'مصرف مدل‌ها',
      failedRequests: 'درخواست‌های ناموفق',
      plans: 'پلن‌ها و بسته‌های اعتبار',
      finance: 'مالی و تلگرام استارز',
      users: 'مدیریت کاربران',
      transactions: 'تراکنش‌ها',
      referrals: 'معرفی و کوپن‌ها',
      support: 'تیکت‌های پشتیبانی',
      notifications: 'قالب‌های اعلان',
      analytics: 'تحلیل مصرف',
      settings: 'تنظیمات سیستم',
      security: 'امنیت و گزارش ممیزی',
    },
    common: {
      save: 'ذخیره تغییرات',
      saving: 'در حال ذخیره...',
      cancel: 'انصراف',
      create: 'ایجاد جدید',
      edit: 'ویرایش',
      delete: 'حذف',
      refresh: 'بروزرسانی',
      searchPlaceholder: 'جستجو...',
      active: 'فعال',
      inactive: 'غیرفعال',
      enabled: 'فعال',
      disabled: 'غیرفعال',
      all: 'همه',
      loading: 'در حال بارگذاری...',
      noData: 'داده‌ای ثبت نشده است',
      actions: 'عملیات',
      status: 'وضعیت',
      createdAt: 'تاریخ ایجاد',
      updatedAt: 'آخرین بروزرسانی',
      logout: 'خروج امن',
      confirmDelete: 'آیا از حذف این مورد اطمینان دارید؟',
      testConnection: 'تست اتصال',
      testing: 'در حال بررسی...',
      rotateKey: 'چرخش کلید',
      close: 'بستن',
      yes: 'بله',
      no: 'خیر',
    },
    auth: {
      loginTitle: 'ورود به پنل مدیریت هوش‌نگار',
      loginSubtitle: 'احراز هویت امن مبتنی بر Argon2id و نشست سمت سرور HttpOnly',
      setupTitle: 'راه‌اندازی اولیه مدیر ارشد سیستم',
      setupSubtitle: 'هیچ حساب مدیریتی در پایگاه‌داده وجود ندارد. نخستین حساب مدیر ارشد را ایجاد کنید.',
      emailLabel: 'ایمیل سازمانی مدیر',
      passwordLabel: 'رمز عبور امن',
      fullNameLabel: 'نام و نام خانوادگی مدیر',
      signInButton: 'ورود به پنل مدیریت',
      createAdminButton: 'ایجاد مدیر ارشد و ورود',
      passwordHint: 'حداقل ۱۲ کاراکتر شامل حروف بزرگ، کوچک و عدد انگلیسی',
      securityNote: 'تمام نشست‌ها در پایگاه‌داده ثبت شده و با محافظت CSRF و محدودیت نرخ تلاش ایمن شده‌اند.',
    },
    providerTypes: {
      openai_compatible: 'سازگار با OpenAI',
      google_gemini: 'Google Gemini بومی',
      anthropic: 'Anthropic بومی',
      replicate: 'Replicate',
      fal_ai: 'fal.ai',
      huggingface: 'Hugging Face (مدل / Router)',
      huggingface_space: 'Hugging Face Space (اسپیس / Gradio)',
      custom: 'ارائه‌دهنده سفارشی',
    },
    connectionStatuses: {
      untested: 'آزمایش‌نشده',
      connected: 'متصل',
      degraded: 'کند / محدودیت نرخ',
      failed: 'خطا در اتصال',
    },
    modelCategories: {
      llm: 'مدل زبانی (LLM)',
      multimodal: 'چندوجهی (Multimodal)',
      image: 'تولید و ویرایش تصویر',
      audio: 'صوت و گفتار',
      video: 'تولید ویدیو',
      embedding: 'بردارسازی (Embeddings)',
      document: 'تحلیل اسناد و فایل',
    },
    capabilities: {
      text_generation: 'تولید متن',
      chat: 'گفتگو (Chat)',
      vision: 'درک تصویر (Vision)',
      image_generation: 'تولید تصویر',
      image_editing: 'ویرایش تصویر',
      image_variation: 'تنوع تصویر',
      audio_transcription: 'تبدیل گفتار به متن',
      speech_generation: 'تبدیل متن به گفتار',
      video_generation: 'تولید ویدیو',
      embeddings: 'بردارسازی متن',
      document_analysis: 'تحلیل اسناد و فایل',
    },
    planTiers: {
      free: 'رایگان (Free)',
      basic: 'پایه (Basic)',
      pro: 'حرفه‌ای (Pro)',
      premium: 'ویژه (Premium)',
      enterprise: 'سازمانی (Enterprise)',
      custom: 'سفارشی (Custom)',
    },
  },
  en: {
    appName: 'HooshNegar',
    phaseLabel: 'Phase 3 · Subscriptions, Stars & Finance',
    nav: {
      dashboard: 'Dashboard',
      providers: 'AI Providers',
      models: 'AI Models',
      credentials: 'API Credentials',
      telegram: 'Telegram Bot Settings',
      botMonitor: 'Telegram Bot Monitor',
      connectedUsers: 'Connected Users',
      conversations: 'Conversation Logs',
      aiRequests: 'AI Requests',
      generationJobs: 'Generation Jobs',
      providerPerformance: 'Provider Performance',
      modelUsage: 'Model Usage',
      failedRequests: 'Failed Requests',
      plans: 'Plans & Credit Packs',
      finance: 'Finance & Stars',
      users: 'User Management',
      transactions: 'Transactions',
      referrals: 'Referrals & Coupons',
      support: 'Support Tickets',
      notifications: 'Notification Templates',
      analytics: 'Usage Analytics',
      settings: 'System Settings',
      security: 'Security & Audit Logs',
    },
    common: {
      save: 'Save Changes',
      saving: 'Saving...',
      cancel: 'Cancel',
      create: 'Create New',
      edit: 'Edit',
      delete: 'Delete',
      refresh: 'Refresh',
      searchPlaceholder: 'Search...',
      active: 'Active',
      inactive: 'Inactive',
      enabled: 'Enabled',
      disabled: 'Disabled',
      all: 'All',
      loading: 'Loading...',
      noData: 'No records found',
      actions: 'Actions',
      status: 'Status',
      createdAt: 'Created',
      updatedAt: 'Updated',
      logout: 'Sign Out',
      confirmDelete: 'Are you sure you want to delete this item?',
      testConnection: 'Test Connection',
      testing: 'Testing...',
      rotateKey: 'Rotate Key',
      close: 'Close',
      yes: 'Yes',
      no: 'No',
    },
    auth: {
      loginTitle: 'Sign in to HooshNegar Admin',
      loginSubtitle: 'Argon2id credential verification with HttpOnly server-side sessions',
      setupTitle: 'Initialize Super Admin Account',
      setupSubtitle: 'No administrator account exists in PostgreSQL yet. Create the initial super admin.',
      emailLabel: 'Admin Email',
      passwordLabel: 'Secure Password',
      fullNameLabel: 'Administrator Full Name',
      signInButton: 'Sign In to Console',
      createAdminButton: 'Create Super Admin & Continue',
      passwordHint: 'Minimum 12 characters with uppercase, lowercase, and numbers',
      securityNote: 'All admin sessions are persisted server-side with CSRF validation and brute-force protection.',
    },
    providerTypes: {
      openai_compatible: 'OpenAI-Compatible',
      google_gemini: 'Google Gemini Native',
      anthropic: 'Anthropic Native',
      replicate: 'Replicate',
      fal_ai: 'fal.ai',
      huggingface: 'Hugging Face (Models / Router)',
      huggingface_space: 'Hugging Face Space (Gradio / ZeroGPU)',
      custom: 'Custom HTTP Provider',
    },
    connectionStatuses: {
      untested: 'Untested',
      connected: 'Connected',
      degraded: 'Degraded / Rate Limited',
      failed: 'Connection Failed',
    },
    modelCategories: {
      llm: 'Language Model (LLM)',
      multimodal: 'Multimodal',
      image: 'Image Generation',
      audio: 'Audio & Speech',
      video: 'Video Generation',
      embedding: 'Embeddings',
      document: 'Document Analysis',
    },
    capabilities: {
      text_generation: 'Text Generation',
      chat: 'Chat',
      vision: 'Vision',
      image_generation: 'Image Generation',
      image_editing: 'Image Editing',
      image_variation: 'Image Variation',
      audio_transcription: 'Audio Transcription',
      speech_generation: 'Speech Generation',
      video_generation: 'Video Generation',
      embeddings: 'Embeddings',
      document_analysis: 'Document Analysis',
    },
    planTiers: {
      free: 'Free',
      basic: 'Basic',
      pro: 'Pro',
      premium: 'Premium',
      enterprise: 'Enterprise',
      custom: 'Custom',
    },
  },
};

export function formatDateTime(value: string | Date | null | undefined, locale: Locale): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'fa' ? 'fa-IR' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US').format(value);
}
