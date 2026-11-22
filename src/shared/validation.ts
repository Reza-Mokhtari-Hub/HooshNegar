import { z } from 'zod';

export const PROVIDER_TYPES = [
  'openai_compatible',
  'google_gemini',
  'anthropic',
  'replicate',
  'fal_ai',
  'custom',
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const MODEL_CATEGORIES = [
  'llm',
  'multimodal',
  'image',
  'audio',
  'video',
  'embedding',
  'document',
] as const;
export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

export const CAPABILITY_TYPES = [
  'text_generation',
  'chat',
  'vision',
  'image_generation',
  'image_editing',
  'image_variation',
  'audio_transcription',
  'speech_generation',
  'video_generation',
  'embeddings',
  'document_analysis',
] as const;
export type CapabilityType = (typeof CAPABILITY_TYPES)[number];

export const PLAN_TIERS = ['free', 'basic', 'pro', 'premium', 'enterprise', 'custom'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const BILLING_INTERVALS = ['one_time', 'weekly', 'monthly', 'quarterly', 'yearly', 'lifetime'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const SUBSCRIPTION_STATUSES = [
  'active',
  'pending',
  'trialing',
  'past_due',
  'canceled',
  'expired',
  'suspended',
  'payment_failed',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const ADMIN_ROLES = ['super_admin', 'admin', 'operator', 'auditor'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const SUPPORT_CATEGORIES = ['general', 'payment', 'failed_request', 'refund'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const TICKET_STATUSES = ['open', 'in_progress', 'waiting_user', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const COUPON_DISCOUNT_TYPES = ['percentage', 'fixed', 'fixed_credits', 'gift_credits', 'promotional'] as const;
export type CouponDiscountType = (typeof COUPON_DISCOUNT_TYPES)[number];

export const strongPasswordSchema = z
  .string()
  .min(12, 'رمز عبور باید حداقل ۱۲ کاراکتر باشد')
  .max(128, 'رمز عبور بیش از حد طولانی است')
  .regex(/[A-Z]/, 'رمز عبور باید حداقل یک حرف بزرگ انگلیسی داشته باشد')
  .regex(/[a-z]/, 'رمز عبور باید حداقل یک حرف کوچک انگلیسی داشته باشد')
  .regex(/[0-9]/, 'رمز عبور باید حداقل یک عدد داشته باشد');

export const adminSetupSchema = z.object({
  email: z.string().trim().email('ایمیل معتبر وارد کنید').max(255),
  fullName: z.string().trim().min(2, 'نام کامل الزامی است').max(160),
  password: strongPasswordSchema,
});

export const adminLoginSchema = z.object({
  email: z.string().trim().email('ایمیل معتبر وارد کنید').max(255),
  password: z.string().min(1, 'رمز عبور الزامی است').max(128),
});

export const safeUrlSchema = z
  .string()
  .trim()
  .url('آدرس URL معتبر وارد کنید')
  .refine((val) => val.startsWith('https://') || val.startsWith('http://'), {
    message: 'آدرس باید با http:// یا https:// شروع شود',
  });

export const providerCreateSchema = z.object({
  name: z.string().trim().min(2, 'نام ارائه‌دهنده حداقل ۲ کاراکتر باشد').max(120),
  providerType: z.enum(PROVIDER_TYPES),
  baseUrl: safeUrlSchema,
  apiKey: z.string().trim().min(6, 'کلید API معتبر وارد کنید').max(512),
  organizationId: z.string().trim().max(160).optional().or(z.literal('')),
  additionalHeaders: z.record(z.string().min(1).max(100), z.string().max(1000)).optional().default({}),
  isActive: z.boolean().optional().default(true),
  priority: z.coerce.number().int().min(0).max(10000).optional().default(100),
});

export const providerUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  providerType: z.enum(PROVIDER_TYPES).optional(),
  baseUrl: safeUrlSchema.optional(),
  organizationId: z.string().trim().max(160).nullable().optional(),
  additionalHeaders: z.record(z.string().min(1).max(100), z.string().max(1000)).optional(),
  isActive: z.boolean().optional(),
  priority: z.coerce.number().int().min(0).max(10000).optional(),
});

export const providerRotateKeySchema = z.object({
  apiKey: z.string().trim().min(6, 'کلید جدید معتبر وارد کنید').max(512),
  label: z.string().trim().min(1).max(120).optional().default('primary'),
});

export const modelCreateSchema = z.object({
  providerId: z.string().uuid('ارائه‌دهنده معتبر انتخاب کنید'),
  name: z.string().trim().min(2, 'نام مدل الزامی است').max(140),
  modelIdentifier: z.string().trim().min(2, 'شناسه مدل الزامی است').max(200),
  category: z.enum(MODEL_CATEGORIES),
  description: z.string().trim().max(2000).optional().default(''),
  capabilities: z
    .array(z.enum(CAPABILITY_TYPES))
    .min(1, 'حداقل یک قابلیت برای مدل انتخاب کنید')
    .max(11),
  inputPricePerMillion: z.coerce.number().min(0).max(100000).default(0),
  outputPricePerMillion: z.coerce.number().min(0).max(100000).default(0),
  creditCost: z.coerce.number().min(0).max(100000).default(1),
  minCreditCost: z.coerce.number().min(0).max(100000).optional().default(0),
  providerCostPerOpUsd: z.coerce.number().min(0).max(1000).optional().default(0),
  allowedPlanTiers: z.array(z.enum(PLAN_TIERS)).optional().default([]),
  priority: z.coerce.number().int().min(0).max(10000).default(100),
  isDefault: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
  maxInputSize: z.coerce.number().int().min(1).max(10000000).default(128000),
  maxOutputSize: z.coerce.number().int().min(1).max(10000000).default(8192),
  fallbackProviderId: z.string().uuid().nullable().optional().or(z.literal('')),
  fallbackModelIdentifier: z.string().trim().max(200).nullable().optional().or(z.literal('')),
  modelParameters: z.record(z.string(), z.unknown()).optional().default({}),
});

export const modelUpdateSchema = modelCreateSchema.partial();

export const telegramSettingsUpdateSchema = z.object({
  botToken: z.string().trim().max(512).optional().or(z.literal('')),
  botUsername: z.string().trim().max(128).default(''),
  botDisplayName: z.string().trim().max(160).default(''),
  webhookUrl: z
    .string()
    .trim()
    .max(512)
    .refine((v) => v === '' || v.startsWith('https://'), {
      message: 'آدرس وب‌هوک تلگرام باید با https:// شروع شود',
    })
    .default(''),
  webhookSecret: z.string().trim().max(256).optional().or(z.literal('')),
  isActive: z.boolean().default(false),
  welcomeMessage: z.string().trim().min(1, 'پیام خوش‌آمدگویی الزامی است').max(4000),
  defaultLanguage: z.enum(['fa', 'en']).default('fa'),
  supportUsername: z.string().trim().max(128).default(''),
  defaultModelId: z.string().uuid().nullable().optional(),
  errorMessages: z.object({
    rateLimit: z.string().trim().min(1).max(500),
    maintenance: z.string().trim().min(1).max(500),
    providerError: z.string().trim().min(1).max(500),
    insufficientCredits: z.string().trim().min(1).max(500),
    unsupportedCapability: z.string().trim().min(1).max(500),
  }),
});

export const subscriptionPlanBaseSchema = z.object({
  name: z.string().trim().min(2, 'نام پلن الزامی است').max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'اسلاگ فقط شامل حروف کوچک انگلیسی، عدد و خط تیره باشد'),
  tier: z.enum(PLAN_TIERS),
  description: z.string().trim().max(2000).optional().default(''),
  priceAmount: z.coerce.number().min(0).max(999999999999).default(0),
  currency: z.enum(['XTR', 'IRR', 'IRT', 'USD', 'EUR']).default('XTR'),
  starsPrice: z.coerce.number().int().min(0).max(100000).optional().default(0),
  billingInterval: z.enum(BILLING_INTERVALS).optional().default('monthly'),
  isRecurringStars: z.boolean().optional().default(false),
  durationDays: z.coerce.number().int().min(1).max(3650).default(30),
  allowedProviderIds: z.array(z.string().uuid()).optional().default([]),
  availableModelIds: z.array(z.string().uuid()).optional().default([]),
  dailyRequestLimit: z.coerce.number().int().min(0).max(1000000).default(50),
  monthlyRequestLimit: z.coerce.number().int().min(0).max(10000000).default(1000),
  dailyTextLimit: z.coerce.number().int().min(0).max(1000000).optional().default(50),
  textGenerationLimit: z.coerce.number().int().min(0).max(10000000).default(1000),
  dailyImageLimit: z.coerce.number().int().min(0).max(1000000).optional().default(10),
  imageGenerationLimit: z.coerce.number().int().min(0).max(1000000).default(20),
  audioGenerationLimit: z.coerce.number().int().min(0).max(1000000).default(10),
  dailyVideoLimit: z.coerce.number().int().min(0).max(100000).optional().default(2),
  videoGenerationLimit: z.coerce.number().int().min(0).max(100000).default(0),
  maxFileSizeMb: z.coerce.number().int().min(1).max(2048).default(10),
  maxContextLength: z.coerce.number().int().min(1000).max(2000000).optional().default(16000),
  maxConcurrentTasks: z.coerce.number().int().min(1).max(100).default(2),
  creditAllocation: z.coerce.number().int().min(0).max(100000000).default(100),
  priorityQueue: z.boolean().optional().default(false),
  features: z.array(z.string().trim().min(1).max(200)).optional().default([]),
  restrictions: z.array(z.string().trim().min(1).max(200)).optional().default([]),
  isEnabled: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(1000).optional().default(0),
});

export const subscriptionPlanSchema = subscriptionPlanBaseSchema.superRefine((data, ctx) => {
  if (data.isRecurringStars) {
    if (data.starsPrice < 1 || data.starsPrice > 2500) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['starsPrice'],
        message: 'برای اشتراک تمدید خودکار تلگرام استارز، قیمت باید بین ۱ تا ۲۵۰۰ استارز باشد',
      });
    }
    if (data.durationDays !== 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationDays'],
        message: 'دوره اشتراک تمدید خودکار تلگرام استارز باید دقیقاً ۳۰ روز (۲۵۹۲۰۰۰ ثانیه) باشد',
      });
    }
  }
});

export const subscriptionPlanUpdateSchema = subscriptionPlanBaseSchema.partial().superRefine((data, ctx) => {
  if (data.isRecurringStars) {
    if (data.starsPrice !== undefined && (data.starsPrice < 1 || data.starsPrice > 2500)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['starsPrice'],
        message: 'برای اشتراک تمدید خودکار تلگرام استارز، قیمت باید بین ۱ تا ۲۵۰۰ استارز باشد',
      });
    }
    if (data.durationDays !== undefined && data.durationDays !== 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationDays'],
        message: 'دوره اشتراک تمدید خودکار تلگرام استارز باید دقیقاً ۳۰ روز (۲۵۹۲۰۰۰ ثانیه) باشد',
      });
    }
  }
});

export const creditPackageSchema = z.object({
  name: z.string().trim().min(2, 'نام بسته اعتبار الزامی است').max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'اسلاگ فقط شامل حروف کوچک انگلیسی، عدد و خط تیره باشد'),
  description: z.string().trim().max(1000).optional().default(''),
  creditsAmount: z.coerce.number().int().min(1, 'مقدار اعتبار باید مثبت باشد').max(100000000),
  bonusCredits: z.coerce.number().int().min(0).max(100000000).optional().default(0),
  starsPrice: z.coerce.number().int().min(1, 'قیمت استارز باید حداقل ۱ باشد').max(100000),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.coerce.number().int().min(0).max(1000).optional().default(0),
});

export const systemSettingsSchema = z.object({
  appName: z.string().trim().min(2).max(120),
  logoUrl: z.string().trim().max(1000).optional().default(''),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'کد رنگ هگز معتبر وارد کنید'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'کد رنگ هگز معتبر وارد کنید'),
  defaultTimezone: z.string().trim().min(2).max(64),
  defaultLanguage: z.enum(['fa', 'en']),
  supportContact: z.string().trim().max(200).optional().default(''),
  maintenanceMode: z.boolean(),
  registrationEnabled: z.boolean(),
  defaultUserPlanId: z.string().uuid().nullable().optional().or(z.literal('')),
  globalRequestsPerMinute: z.coerce.number().int().min(1).max(1000000),
  globalRequestsPerDay: z.coerce.number().int().min(1).max(100000000),
  creditValueUsd: z.coerce.number().min(0).max(100).optional().default(0.01),
  starValueUsd: z.coerce.number().min(0).max(10).optional().default(0.013),
  lowCreditThreshold: z.coerce.number().min(0).max(100000).optional().default(15),
  allowNegativeBalance: z.boolean().optional().default(false),
  dataRetentionDays: z.coerce.number().int().min(7).max(3650).optional().default(365),
});

export const referralCodeCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3)
    .max(48)
    .regex(/^[A-Z0-9_-]+$/i, 'کد معرفی فقط شامل حروف انگلیسی، عدد، خط تیره و زیرخط باشد'),
  rewardCredits: z.coerce.number().int().min(1).max(1000000),
  maxUses: z.coerce.number().int().min(1).max(1000000).nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

export const referralProgramSettingsSchema = z.object({
  isActive: z.boolean(),
  inviterRewardType: z.enum(['credits', 'subscription_days', 'promotional_credits']),
  inviterBonusCredits: z.coerce.number().int().min(0).max(1000000),
  inviterFreeDays: z.coerce.number().int().min(0).max(365),
  invitedBonusCredits: z.coerce.number().int().min(0).max(1000000),
  requirePurchase: z.boolean(),
  minPurchaseStars: z.coerce.number().int().min(0).max(100000),
  minPlanTier: z.enum(PLAN_TIERS),
  maxReferralsPerAccount: z.coerce.number().int().min(1).max(100000),
  maxRewardCreditsPerAccount: z.coerce.number().int().min(0).max(100000000),
  fraudVelocityLimitPerHour: z.coerce.number().int().min(1).max(1000),
  campaignStartsAt: z.string().datetime().nullable().optional().or(z.literal('')),
  campaignEndsAt: z.string().datetime().nullable().optional().or(z.literal('')),
});

export const couponCreateSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[A-Z0-9_-]+$/i, 'کد تخفیف معتبر وارد کنید'),
    discountType: z.enum(COUPON_DISCOUNT_TYPES),
    discountValue: z.coerce.number().positive('مقدار تخفیف یا اعتبار باید مثبت باشد'),
    maxRedemptions: z.coerce.number().int().min(1).nullable().optional(),
    perUserLimit: z.coerce.number().int().min(1).max(100).optional().default(1),
    minStarsAmount: z.coerce.number().int().min(0).max(100000).optional().default(0),
    applicablePlanIds: z.array(z.string().uuid()).optional().default([]),
    startsAt: z.string().datetime().nullable().optional().or(z.literal('')),
    expiresAt: z.string().datetime().nullable().optional().or(z.literal('')),
    isActive: z.boolean().optional().default(true),
  })
  .superRefine((data, ctx) => {
    if (data.discountType === 'percentage' && data.discountValue > 95) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discountValue'],
        message: 'درصد تخفیف استارز نمی‌تواند بیشتر از ۹۵٪ باشد',
      });
    }
  });

export const userStatusUpdateSchema = z.object({
  status: z.enum(['active', 'suspended', 'banned', 'pending']),
  reason: z.string().trim().max(500).optional().default(''),
});

export const creditAdjustmentSchema = z.object({
  amount: z.coerce
    .number()
    .refine((v) => v !== 0 && Math.abs(v) <= 10000000, 'مبلغ تغییر اعتبار باید غیرصفر و معتبر باشد'),
  type: z.enum(['adjustment', 'promotional_credit', 'grant', 'refund']).optional().default('adjustment'),
  reason: z.string().trim().min(3, 'دلیل تغییر اعتبار الزامی است').max(500),
});

export const manualPlanAssignSchema = z.object({
  planId: z.string().uuid('پلن معتبر انتخاب کنید'),
  durationDays: z.coerce.number().int().min(1).max(3650).optional(),
  grantCredits: z.boolean().optional().default(true),
  reason: z.string().trim().min(3, 'دلیل تغییر پلن الزامی است').max(500),
});

export const userLimitOverrideSchema = z.object({
  dailyRequestLimit: z.coerce.number().int().min(0).max(1000000).nullable().optional(),
  monthlyRequestLimit: z.coerce.number().int().min(0).max(10000000).nullable().optional(),
  dailyTextLimit: z.coerce.number().int().min(0).max(1000000).nullable().optional(),
  dailyImageLimit: z.coerce.number().int().min(0).max(1000000).nullable().optional(),
  dailyVideoLimit: z.coerce.number().int().min(0).max(100000).nullable().optional(),
  maxConcurrentTasks: z.coerce.number().int().min(1).max(100).nullable().optional(),
  reason: z.string().trim().max(500).optional().default(''),
});

export const supportReplySchema = z.object({
  reply: z.string().trim().min(2, 'متن پاسخ الزامی است').max(3500),
  status: z.enum(TICKET_STATUSES).optional().default('resolved'),
  notifyTelegram: z.boolean().optional().default(true),
});

export const supportTicketUpdateSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
});

export const notificationTemplateUpdateSchema = z.object({
  titleFa: z.string().trim().min(2).max(160),
  bodyFa: z.string().trim().min(2).max(3000),
  bodyEn: z.string().trim().max(3000).optional().default(''),
  isEnabled: z.boolean(),
});

export const refundPaymentSchema = z.object({
  reason: z.string().trim().min(3, 'دلیل بازپرداخت الزامی است').max(500),
  revokeBenefits: z.boolean().optional().default(true),
});
