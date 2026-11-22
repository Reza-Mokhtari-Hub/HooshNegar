import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  bigint,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

// =============================================================================
// ENUMS
// =============================================================================

export const adminRoleEnum = pgEnum('admin_role', [
  'super_admin',
  'admin',
  'operator',
  'auditor',
]);

export const accountStatusEnum = pgEnum('account_status', [
  'active',
  'suspended',
  'banned',
  'pending',
]);

export const providerTypeEnum = pgEnum('provider_type', [
  'openai_compatible',
  'google_gemini',
  'anthropic',
  'replicate',
  'fal_ai',
  'custom',
]);

export const connectionStatusEnum = pgEnum('connection_status', [
  'untested',
  'connected',
  'degraded',
  'failed',
]);

export const modelCategoryEnum = pgEnum('model_category', [
  'llm',
  'multimodal',
  'image',
  'audio',
  'video',
  'embedding',
  'document',
]);

export const capabilityTypeEnum = pgEnum('capability_type', [
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
]);

export const planTierEnum = pgEnum('plan_tier', [
  'free',
  'basic',
  'pro',
  'premium',
  'enterprise',
  'custom',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'pending',
  'trialing',
  'past_due',
  'canceled',
  'expired',
  'suspended',
  'payment_failed',
]);

export const transactionTypeEnum = pgEnum('transaction_type', [
  'grant',
  'purchase',
  'subscription_credit',
  'promotional_credit',
  'usage_debit',
  'refund',
  'referral_bonus',
  'adjustment',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'refunded',
  'canceled',
]);

export const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);

export const ticketStatusEnum = pgEnum('ticket_status', [
  'open',
  'in_progress',
  'waiting_user',
  'resolved',
  'closed',
]);

export const ticketPriorityEnum = pgEnum('ticket_priority', [
  'low',
  'medium',
  'high',
  'urgent',
]);

// =============================================================================
// 1. ADMIN USERS & SESSIONS (RBAC + Secure Server-Side Sessions)
// =============================================================================

export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    fullName: varchar('full_name', { length: 160 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    role: adminRoleEnum('role').notNull().default('admin'),
    permissions: jsonb('permissions').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: accountStatusEnum('status').notNull().default('active'),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    lastLoginIp: varchar('last_login_ip', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('admin_users_email_uidx').on(t.email),
    index('admin_users_role_status_idx').on(t.role, t.status),
  ],
);

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    csrfToken: varchar('csrf_token', { length: 128 }).notNull(),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('admin_sessions_token_hash_uidx').on(t.tokenHash),
    index('admin_sessions_admin_user_idx').on(t.adminUserId),
    index('admin_sessions_expires_at_idx').on(t.expiresAt),
  ],
);

// =============================================================================
// 2. END USERS, PROFILES & TELEGRAM ACCOUNTS
// =============================================================================

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    externalUid: varchar('external_uid', { length: 128 }),
    email: varchar('email', { length: 255 }),
    phoneNumber: varchar('phone_number', { length: 32 }),
    status: accountStatusEnum('status').notNull().default('active'),
    locale: varchar('locale', { length: 16 }).notNull().default('fa'),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_uidx').on(t.email),
    uniqueIndex('users_external_uid_uidx').on(t.externalUid),
    index('users_status_created_idx').on(t.status, t.createdAt),
  ],
);

export const userProfiles = pgTable(
  'user_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: varchar('display_name', { length: 160 }),
    firstName: varchar('first_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }),
    avatarUrl: text('avatar_url'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Tehran'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('user_profiles_user_id_uidx').on(t.userId)],
);

export interface TelegramUserBotState {
  mode?:
    | 'chat'
    | 'image_prompt'
    | 'image_edit_photo'
    | 'image_edit_prompt'
    | 'image_variation_photo'
    | 'video_prompt'
    | 'video_image_photo'
    | 'video_image_prompt'
    | 'audio_tts_prompt'
    | 'audio_stt_wait'
    | 'document_wait'
    | 'system_prompt_input'
    | 'support_message'
    | 'paysupport_message'
    | 'coupon_redeem_input';
  imageParams?: {
    aspectRatio?: string;
    resolution?: string;
    count?: number;
    sourceFileId?: string;
    sourceMimeType?: string;
  };
  videoParams?: {
    durationSeconds?: number;
    aspectRatio?: string;
    quality?: string;
    sourceFileId?: string;
  };
  audioParams?: {
    voice?: string;
    language?: string;
    outputMode?: 'voice' | 'audio';
  };
  activeRequestId?: string | null;
  cancelRequestedAt?: string | null;
}

export const telegramAccounts = pgTable(
  'telegram_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
    username: varchar('username', { length: 128 }),
    firstName: varchar('first_name', { length: 128 }),
    lastName: varchar('last_name', { length: 128 }),
    languageCode: varchar('language_code', { length: 16 }).default('fa'),
    isBlockedByUser: boolean('is_blocked_by_user').notNull().default(false),
    isPremiumTelegram: boolean('is_premium_telegram').notNull().default(false),
    selectedTextModelId: uuid('selected_text_model_id'),
    selectedImageModelId: uuid('selected_image_model_id'),
    selectedVideoModelId: uuid('selected_video_model_id'),
    selectedAudioModelId: uuid('selected_audio_model_id'),
    selectedDocumentModelId: uuid('selected_document_model_id'),
    activeConversationId: uuid('active_conversation_id'),
    systemPrompt: text('system_prompt').notNull().default(''),
    botState: jsonb('bot_state').$type<TelegramUserBotState>().notNull().default(sql`'{}'::jsonb`),
    lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('telegram_accounts_tg_user_uidx').on(t.telegramUserId),
    index('telegram_accounts_user_idx').on(t.userId),
    index('telegram_accounts_username_idx').on(t.username),
  ],
);

// =============================================================================
// 3. AI PROVIDERS, ENCRYPTED CREDENTIALS, AI MODELS & CAPABILITIES
// =============================================================================

export const aiProviders = pgTable(
  'ai_providers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    slug: varchar('slug', { length: 120 }).notNull(),
    providerType: providerTypeEnum('provider_type').notNull(),
    baseUrl: text('base_url').notNull(),
    organizationId: varchar('organization_id', { length: 160 }),
    additionalHeaders: jsonb('additional_headers')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    connectionStatus: connectionStatusEnum('connection_status').notNull().default('untested'),
    lastTestMessage: text('last_test_message'),
    lastTestLatencyMs: integer('last_test_latency_ms'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    priority: integer('priority').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_providers_slug_uidx').on(t.slug),
    index('ai_providers_active_priority_idx').on(t.isActive, t.priority),
    index('ai_providers_type_idx').on(t.providerType),
    check('ai_providers_priority_non_negative', sql`${t.priority} >= 0`),
  ],
);

export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => aiProviders.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 120 }).notNull().default('primary'),
    encryptedApiKey: text('encrypted_api_key').notNull(),
    iv: varchar('iv', { length: 64 }).notNull(),
    authTag: varchar('auth_tag', { length: 64 }).notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    maskedPreview: varchar('masked_preview', { length: 64 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('provider_credentials_provider_active_idx').on(t.providerId, t.isActive),
  ],
);

export const aiModels = pgTable(
  'ai_models',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => aiProviders.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 140 }).notNull(),
    modelIdentifier: varchar('model_identifier', { length: 200 }).notNull(),
    category: modelCategoryEnum('category').notNull().default('llm'),
    description: text('description').notNull().default(''),
    inputPricePerMillion: numeric('input_price_per_million', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    outputPricePerMillion: numeric('output_price_per_million', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    creditCost: numeric('credit_cost', { precision: 12, scale: 4 }).notNull().default('1'),
    minCreditCost: numeric('min_credit_cost', { precision: 12, scale: 4 }).notNull().default('0'),
    providerCostPerOpUsd: numeric('provider_cost_per_op_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    allowedPlanTiers: jsonb('allowed_plan_tiers')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    priority: integer('priority').notNull().default(100),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    maxInputSize: integer('max_input_size').notNull().default(128000),
    maxOutputSize: integer('max_output_size').notNull().default(8192),
    fallbackProviderId: uuid('fallback_provider_id').references(() => aiProviders.id, {
      onDelete: 'set null',
    }),
    fallbackModelIdentifier: varchar('fallback_model_identifier', { length: 200 }),
    modelParameters: jsonb('model_parameters')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_models_provider_identifier_uidx').on(t.providerId, t.modelIdentifier),
    index('ai_models_active_priority_idx').on(t.isActive, t.priority),
    index('ai_models_category_idx').on(t.category),
    check('ai_models_credit_cost_non_negative', sql`${t.creditCost} >= 0`),
  ],
);

export const modelCapabilities = pgTable(
  'model_capabilities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => aiModels.id, { onDelete: 'cascade' }),
    capability: capabilityTypeEnum('capability').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('model_capabilities_model_cap_uidx').on(t.modelId, t.capability),
    index('model_capabilities_cap_idx').on(t.capability),
  ],
);

// =============================================================================
// 4. TELEGRAM BOT CONFIGURATION (Encrypted Token + Webhook Ready)
// =============================================================================

export const telegramBotSettings = pgTable('telegram_bot_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  singletonKey: varchar('singleton_key', { length: 32 }).notNull().default('primary').unique(),
  encryptedBotToken: text('encrypted_bot_token'),
  tokenIv: varchar('token_iv', { length: 64 }),
  tokenAuthTag: varchar('token_auth_tag', { length: 64 }),
  maskedBotToken: varchar('masked_bot_token', { length: 64 }),
  botUsername: varchar('bot_username', { length: 128 }).notNull().default(''),
  botDisplayName: varchar('bot_display_name', { length: 160 }).notNull().default(''),
  webhookUrl: text('webhook_url').notNull().default(''),
  encryptedWebhookSecret: text('encrypted_webhook_secret'),
  webhookSecretIv: varchar('webhook_secret_iv', { length: 64 }),
  webhookSecretAuthTag: varchar('webhook_secret_auth_tag', { length: 64 }),
  maskedWebhookSecret: varchar('masked_webhook_secret', { length: 64 }),
  isActive: boolean('is_active').notNull().default(false),
  welcomeMessage: text('welcome_message')
    .notNull()
    .default('خوش آمدید! برای شروع گفتگو با هوش مصنوعی پیام خود را ارسال کنید.'),
  defaultLanguage: varchar('default_language', { length: 16 }).notNull().default('fa'),
  supportUsername: varchar('support_username', { length: 128 }).notNull().default(''),
  defaultModelId: uuid('default_model_id').references(() => aiModels.id, { onDelete: 'set null' }),
  errorMessages: jsonb('error_messages')
    .$type<{
      rateLimit: string;
      maintenance: string;
      providerError: string;
      insufficientCredits: string;
      unsupportedCapability: string;
    }>()
    .notNull()
    .default(
      sql`'{"rateLimit":"تعداد درخواست‌های شما به حد مجاز رسیده است. لطفاً کمی بعد تلاش کنید.","maintenance":"سامانه در حال به‌روزرسانی است. به زودی بازمی‌گردیم.","providerError":"خطایی در پردازش هوش مصنوعی رخ داد. لطفاً مجدداً تلاش کنید.","insufficientCredits":"اعتبار حساب شما کافی نیست. لطفاً اشتراک یا اعتبار خود را تمدید کنید.","unsupportedCapability":"مدل انتخاب‌شده از این قابلیت پشتیبانی نمی‌کند."}'::jsonb`,
    ),
  connectionStatus: connectionStatusEnum('connection_status').notNull().default('untested'),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  lastTestMessage: text('last_test_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// =============================================================================
// 5. SUBSCRIPTION PLANS, USER SUBSCRIPTIONS & ENTITLEMENTS
// =============================================================================

export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    slug: varchar('slug', { length: 120 }).notNull(),
    tier: planTierEnum('tier').notNull().default('custom'),
    description: text('description').notNull().default(''),
    priceAmount: numeric('price_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    currency: varchar('currency', { length: 16 }).notNull().default('XTR'),
    starsPrice: integer('stars_price').notNull().default(0),
    billingInterval: varchar('billing_interval', { length: 24 }).notNull().default('monthly'),
    isRecurringStars: boolean('is_recurring_stars').notNull().default(false),
    durationDays: integer('duration_days').notNull().default(30),
    allowedProviderIds: jsonb('allowed_provider_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    availableModelIds: jsonb('available_model_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dailyRequestLimit: integer('daily_request_limit').notNull().default(50),
    monthlyRequestLimit: integer('monthly_request_limit').notNull().default(1000),
    dailyTextLimit: integer('daily_text_limit').notNull().default(50),
    textGenerationLimit: integer('text_generation_limit').notNull().default(1000),
    dailyImageLimit: integer('daily_image_limit').notNull().default(10),
    imageGenerationLimit: integer('image_generation_limit').notNull().default(20),
    audioGenerationLimit: integer('audio_generation_limit').notNull().default(10),
    dailyVideoLimit: integer('daily_video_limit').notNull().default(2),
    videoGenerationLimit: integer('video_generation_limit').notNull().default(0),
    maxFileSizeMb: integer('max_file_size_mb').notNull().default(10),
    maxContextLength: integer('max_context_length').notNull().default(16000),
    maxConcurrentTasks: integer('max_concurrent_tasks').notNull().default(2),
    creditAllocation: integer('credit_allocation').notNull().default(100),
    priorityQueue: boolean('priority_queue').notNull().default(false),
    features: jsonb('features').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    restrictions: jsonb('restrictions').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    isEnabled: boolean('is_enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscription_plans_slug_uidx').on(t.slug),
    index('subscription_plans_tier_enabled_idx').on(t.tier, t.isEnabled),
    check('subscription_plans_duration_positive', sql`${t.durationDays} > 0`),
    check('subscription_plans_price_non_negative', sql`${t.priceAmount} >= 0`),
  ],
);

export const userSubscriptions = pgTable(
  'user_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'restrict' }),
    status: subscriptionStatusEnum('status').notNull().default('active'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    autoRenew: boolean('auto_renew').notNull().default(false),
    telegramChargeId: varchar('telegram_charge_id', { length: 200 }),
    lastPaymentId: uuid('last_payment_id'),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    canceledReason: text('canceled_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('user_subscriptions_user_status_idx').on(t.userId, t.status),
    index('user_subscriptions_ends_at_idx').on(t.endsAt),
  ],
);

export const userEntitlements = pgTable(
  'user_entitlements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id').references(() => userSubscriptions.id, {
      onDelete: 'set null',
    }),
    capability: capabilityTypeEnum('capability').notNull(),
    quotaLimit: integer('quota_limit').notNull().default(0),
    quotaUsed: integer('quota_used').notNull().default(0),
    resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_entitlements_user_cap_uidx').on(t.userId, t.capability),
    check('user_entitlements_quota_non_negative', sql`${t.quotaUsed} >= 0`),
  ],
);

// =============================================================================
// 6. CREDIT WALLETS & LEDGER TRANSACTIONS (Idempotent)
// =============================================================================

export const creditWallets = pgTable(
  'credit_wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    balance: numeric('balance', { precision: 16, scale: 4 }).notNull().default('0'),
    reservedBalance: numeric('reserved_balance', { precision: 16, scale: 4 })
      .notNull()
      .default('0'),
    lifetimeEarned: numeric('lifetime_earned', { precision: 16, scale: 4 }).notNull().default('0'),
    lifetimeSpent: numeric('lifetime_spent', { precision: 16, scale: 4 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credit_wallets_user_id_uidx').on(t.userId),
  ],
);

export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => creditWallets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: transactionTypeEnum('type').notNull(),
    amount: numeric('amount', { precision: 16, scale: 4 }).notNull(),
    balanceBefore: numeric('balance_before', { precision: 16, scale: 4 }).notNull().default('0'),
    balanceAfter: numeric('balance_after', { precision: 16, scale: 4 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
    referenceType: varchar('reference_type', { length: 64 }),
    referenceId: varchar('reference_id', { length: 128 }),
    relatedPaymentId: uuid('related_payment_id'),
    relatedRequestId: uuid('related_request_id'),
    relatedSubscriptionId: uuid('related_subscription_id'),
    adminUserId: uuid('admin_user_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    description: text('description').notNull().default(''),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credit_transactions_idempotency_uidx').on(t.idempotencyKey),
    index('credit_transactions_wallet_created_idx').on(t.walletId, t.createdAt),
    index('credit_transactions_user_created_idx').on(t.userId, t.createdAt),
    index('credit_transactions_type_created_idx').on(t.type, t.createdAt),
  ],
);

// =============================================================================
// 7. USAGE RECORDS, AI REQUESTS, GENERATION JOBS, CONVERSATIONS
// =============================================================================

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    telegramAccountId: uuid('telegram_account_id').references(() => telegramAccounts.id, {
      onDelete: 'set null',
    }),
    modelId: uuid('model_id').references(() => aiModels.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 200 }).notNull().default('گفتگوی جدید'),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    messageCount: integer('message_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversations_user_updated_idx').on(t.userId, t.updatedAt)],
);

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 24 }).notNull(),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull().default(0),
    attachments: jsonb('attachments').$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversation_messages_conv_created_idx').on(t.conversationId, t.createdAt)],
);

export const aiRequests = pgTable(
  'ai_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id').references(() => aiProviders.id, { onDelete: 'set null' }),
    modelId: uuid('model_id').references(() => aiModels.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    capability: capabilityTypeEnum('capability').notNull(),
    status: jobStatusEnum('status').notNull().default('queued'),
    idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    creditsCharged: numeric('credits_charged', { precision: 12, scale: 4 }).notNull().default('0'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms'),
    promptPreview: text('prompt_preview'),
    responsePreview: text('response_preview'),
    retryCount: integer('retry_count').notNull().default(0),
    usedFallback: boolean('used_fallback').notNull().default(false),
    errorCode: varchar('error_code', { length: 64 }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('ai_requests_idempotency_uidx').on(t.idempotencyKey),
    index('ai_requests_user_created_idx').on(t.userId, t.createdAt),
    index('ai_requests_provider_model_idx').on(t.providerId, t.modelId),
    index('ai_requests_status_created_idx').on(t.status, t.createdAt),
  ],
);

export const generationJobs = pgTable(
  'generation_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => aiRequests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
    statusMessageId: integer('status_message_id'),
    providerJobId: varchar('provider_job_id', { length: 200 }),
    capability: capabilityTypeEnum('capability').notNull(),
    status: jobStatusEnum('status').notNull().default('queued'),
    progressPercent: integer('progress_percent').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    storageObjectKey: text('storage_object_key'),
    resultMetadata: jsonb('result_metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('generation_jobs_status_idx').on(t.status),
    index('generation_jobs_request_idx').on(t.requestId),
    check('generation_jobs_progress_range', sql`${t.progressPercent} >= 0 AND ${t.progressPercent} <= 100`),
  ],
);

export const storedFiles = pgTable(
  'stored_files',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    requestId: uuid('request_id').references(() => aiRequests.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => generationJobs.id, { onDelete: 'set null' }),
    storageProvider: varchar('storage_provider', { length: 32 }).notNull().default('local_temp'),
    objectKey: text('object_key').notNull(),
    mimeType: varchar('mime_type', { length: 120 }).notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stored_files_object_key_uidx').on(t.objectKey),
    index('stored_files_expires_idx').on(t.expiresAt),
    index('stored_files_user_idx').on(t.userId),
  ],
);

export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id').references(() => aiProviders.id, { onDelete: 'set null' }),
    modelId: uuid('model_id').references(() => aiModels.id, { onDelete: 'set null' }),
    requestId: uuid('request_id').references(() => aiRequests.id, { onDelete: 'set null' }),
    capability: capabilityTypeEnum('capability').notNull(),
    unitsConsumed: integer('units_consumed').notNull().default(1),
    creditsConsumed: numeric('credits_consumed', { precision: 12, scale: 4 })
      .notNull()
      .default('0'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    recordedDate: varchar('recorded_date', { length: 16 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('usage_records_date_idx').on(t.recordedDate),
    index('usage_records_user_date_idx').on(t.userId, t.recordedDate),
    index('usage_records_model_idx').on(t.modelId),
  ],
);

// =============================================================================
// 8. PAYMENTS & PAYMENT EVENTS (Idempotent)
// =============================================================================

export const creditPackages = pgTable(
  'credit_packages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 120 }).notNull(),
    slug: varchar('slug', { length: 120 }).notNull(),
    description: text('description').notNull().default(''),
    creditsAmount: integer('credits_amount').notNull(),
    bonusCredits: integer('bonus_credits').notNull().default(0),
    starsPrice: integer('stars_price').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credit_packages_slug_uidx').on(t.slug),
    check('credit_packages_stars_positive', sql`${t.starsPrice} >= 1`),
    check('credit_packages_credits_positive', sql`${t.creditsAmount} >= 1`),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderNumber: varchar('order_number', { length: 64 }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }),
    planId: uuid('plan_id').references(() => subscriptionPlans.id, { onDelete: 'set null' }),
    creditPackageId: uuid('credit_package_id').references(() => creditPackages.id, {
      onDelete: 'set null',
    }),
    paymentType: varchar('payment_type', { length: 32 }).notNull().default('subscription'),
    gateway: varchar('gateway', { length: 64 }).notNull().default('telegram_stars'),
    gatewayRefId: varchar('gateway_ref_id', { length: 200 }),
    invoicePayload: varchar('invoice_payload', { length: 160 }),
    invoicePayloadHmac: varchar('invoice_payload_hmac', { length: 128 }),
    telegramPaymentChargeId: varchar('telegram_payment_charge_id', { length: 200 }),
    providerPaymentChargeId: varchar('provider_payment_charge_id', { length: 200 }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    discountAmount: numeric('discount_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    currency: varchar('currency', { length: 16 }).notNull().default('XTR'),
    status: paymentStatusEnum('status').notNull().default('pending'),
    couponId: uuid('coupon_id'),
    isRecurring: boolean('is_recurring').notNull().default(false),
    isFirstRecurring: boolean('is_first_recurring').notNull().default(false),
    subscriptionExpirationDate: timestamp('subscription_expiration_date', { withTimezone: true }),
    refundStatus: varchar('refund_status', { length: 32 }).notNull().default('none'),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    refundReason: text('refund_reason'),
    idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payments_idempotency_uidx').on(t.idempotencyKey),
    uniqueIndex('payments_order_number_uidx').on(t.orderNumber),
    uniqueIndex('payments_tg_charge_uidx').on(t.telegramPaymentChargeId),
    index('payments_user_status_idx').on(t.userId, t.status),
    index('payments_created_idx').on(t.createdAt),
    check('payments_amount_non_negative', sql`${t.amount} >= 0`),
  ],
);

export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    eventType: varchar('event_type', { length: 80 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_events_idempotency_uidx').on(t.idempotencyKey),
    index('payment_events_payment_idx').on(t.paymentId),
  ],
);

// =============================================================================
// 9. REFERRALS & COUPONS
// =============================================================================

export const referralCodes = pgTable(
  'referral_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    code: varchar('code', { length: 48 }).notNull(),
    rewardCredits: integer('reward_credits').notNull().default(50),
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('referral_codes_code_uidx').on(t.code),
    index('referral_codes_owner_idx').on(t.ownerUserId),
  ],
);

export const referralRelationships = pgTable(
  'referral_relationships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    referralCodeId: uuid('referral_code_id')
      .notNull()
      .references(() => referralCodes.id, { onDelete: 'cascade' }),
    referrerUserId: uuid('referrer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    referredUserId: uuid('referred_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    qualifiedAt: timestamp('qualified_at', { withTimezone: true }),
    qualifyingPaymentId: uuid('qualifying_payment_id').references(() => payments.id, {
      onDelete: 'set null',
    }),
    fraudScore: integer('fraud_score').notNull().default(0),
    fraudFlags: jsonb('fraud_flags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('referral_relationships_referred_uidx').on(t.referredUserId),
    index('referral_relationships_referrer_idx').on(t.referrerUserId),
  ],
);

export const referralRewards = pgTable(
  'referral_rewards',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    relationshipId: uuid('relationship_id')
      .notNull()
      .references(() => referralRelationships.id, { onDelete: 'cascade' }),
    beneficiaryUserId: uuid('beneficiary_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rewardType: varchar('reward_type', { length: 32 }).notNull().default('credits'),
    creditsAwarded: integer('credits_awarded').notNull().default(0),
    subscriptionDaysAwarded: integer('subscription_days_awarded').notNull().default(0),
    relatedPaymentId: uuid('related_payment_id').references(() => payments.id, {
      onDelete: 'set null',
    }),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
    awardedAt: timestamp('awarded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('referral_rewards_idempotency_uidx').on(t.idempotencyKey),
    index('referral_rewards_beneficiary_idx').on(t.beneficiaryUserId),
  ],
);

export const referralProgramSettings = pgTable('referral_program_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  singletonKey: varchar('singleton_key', { length: 32 }).notNull().default('primary').unique(),
  isActive: boolean('is_active').notNull().default(true),
  inviterRewardType: varchar('inviter_reward_type', { length: 32 }).notNull().default('credits'),
  inviterBonusCredits: integer('inviter_bonus_credits').notNull().default(50),
  inviterFreeDays: integer('inviter_free_days').notNull().default(0),
  invitedBonusCredits: integer('invited_bonus_credits').notNull().default(25),
  requirePurchase: boolean('require_purchase').notNull().default(false),
  minPurchaseStars: integer('min_purchase_stars').notNull().default(0),
  minPlanTier: varchar('min_plan_tier', { length: 32 }).notNull().default('free'),
  maxReferralsPerAccount: integer('max_referrals_per_account').notNull().default(100),
  maxRewardCreditsPerAccount: integer('max_reward_credits_per_account').notNull().default(10000),
  fraudVelocityLimitPerHour: integer('fraud_velocity_limit_per_hour').notNull().default(10),
  campaignStartsAt: timestamp('campaign_starts_at', { withTimezone: true }),
  campaignEndsAt: timestamp('campaign_ends_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const coupons = pgTable(
  'coupons',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: varchar('code', { length: 64 }).notNull(),
    discountType: varchar('discount_type', { length: 32 }).notNull().default('percentage'),
    discountValue: numeric('discount_value', { precision: 12, scale: 2 }).notNull(),
    maxRedemptions: integer('max_redemptions'),
    perUserLimit: integer('per_user_limit').notNull().default(1),
    minStarsAmount: integer('min_stars_amount').notNull().default(0),
    applicablePlanIds: jsonb('applicable_plan_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    redeemedCount: integer('redeemed_count').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('coupons_code_uidx').on(t.code)],
);

export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    couponId: uuid('coupon_id')
      .notNull()
      .references(() => coupons.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    creditsAwarded: integer('credits_awarded').notNull().default(0),
    discountApplied: numeric('discount_applied', { precision: 12, scale: 2 }).notNull().default('0'),
    idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('coupon_redemptions_idempotency_uidx').on(t.idempotencyKey),
    index('coupon_redemptions_coupon_user_idx').on(t.couponId, t.userId),
  ],
);

// =============================================================================
// 10. SYSTEM SETTINGS, AUDIT LOGS, WEBHOOK EVENTS & SUPPORT TICKETS
// =============================================================================

export const systemSettings = pgTable(
  'system_settings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    settingKey: varchar('setting_key', { length: 120 }).notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    category: varchar('category', { length: 64 }).notNull().default('general'),
    isSecret: boolean('is_secret').notNull().default(false),
    updatedByAdminId: uuid('updated_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('system_settings_key_uidx').on(t.settingKey),
    index('system_settings_category_idx').on(t.category),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    adminUserId: uuid('admin_user_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    actorEmail: varchar('actor_email', { length: 255 }),
    action: varchar('action', { length: 120 }).notNull(),
    resourceType: varchar('resource_type', { length: 80 }).notNull(),
    resourceId: varchar('resource_id', { length: 128 }),
    severity: varchar('severity', { length: 24 }).notNull().default('info'),
    status: varchar('status', { length: 24 }).notNull().default('success'),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: text('user_agent'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_created_idx').on(t.createdAt),
    index('audit_logs_action_idx').on(t.action),
    index('audit_logs_admin_idx').on(t.adminUserId),
  ],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    source: varchar('source', { length: 64 }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 180 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('received'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    errorMessage: text('error_message'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('webhook_events_idempotency_uidx').on(t.idempotencyKey),
    index('webhook_events_source_status_idx').on(t.source, t.status),
  ],
);

export const supportTickets = pgTable(
  'support_tickets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assignedAdminId: uuid('assigned_admin_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    category: varchar('category', { length: 32 }).notNull().default('general'),
    relatedPaymentId: uuid('related_payment_id').references(() => payments.id, {
      onDelete: 'set null',
    }),
    relatedRequestId: uuid('related_request_id').references(() => aiRequests.id, {
      onDelete: 'set null',
    }),
    subject: varchar('subject', { length: 200 }).notNull(),
    message: text('message').notNull(),
    adminReply: text('admin_reply'),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    status: ticketStatusEnum('status').notNull().default('open'),
    priority: ticketPriorityEnum('priority').notNull().default('medium'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('support_tickets_status_priority_idx').on(t.status, t.priority),
    index('support_tickets_user_idx').on(t.userId),
    index('support_tickets_category_idx').on(t.category),
  ],
);

// =============================================================================
// 11. NOTIFICATIONS & PER-USER LIMIT OVERRIDES (PHASE 3)
// =============================================================================

export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateKey: varchar('template_key', { length: 64 }).notNull(),
    titleFa: varchar('title_fa', { length: 160 }).notNull(),
    bodyFa: text('body_fa').notNull(),
    bodyEn: text('body_en').notNull().default(''),
    isEnabled: boolean('is_enabled').notNull().default(true),
    updatedByAdminId: uuid('updated_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notification_templates_key_uidx').on(t.templateKey)],
);

export const notificationLogs = pgTable(
  'notification_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
    templateKey: varchar('template_key', { length: 64 }).notNull(),
    dedupKey: varchar('dedup_key', { length: 200 }).notNull(),
    channel: varchar('channel', { length: 32 }).notNull().default('telegram'),
    messageText: text('message_text').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('queued'),
    errorMessage: text('error_message'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_logs_dedup_uidx').on(t.dedupKey),
    index('notification_logs_user_created_idx').on(t.userId, t.createdAt),
    index('notification_logs_template_idx').on(t.templateKey),
  ],
);

export const userLimitOverrides = pgTable(
  'user_limit_overrides',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dailyRequestLimit: integer('daily_request_limit'),
    monthlyRequestLimit: integer('monthly_request_limit'),
    dailyTextLimit: integer('daily_text_limit'),
    dailyImageLimit: integer('daily_image_limit'),
    dailyVideoLimit: integer('daily_video_limit'),
    maxConcurrentTasks: integer('max_concurrent_tasks'),
    reason: text('reason').notNull().default(''),
    updatedByAdminId: uuid('updated_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('user_limit_overrides_user_uidx').on(t.userId)],
);

// =============================================================================
// RELATIONS
// =============================================================================

export const aiProvidersRelations = relations(aiProviders, ({ many }) => ({
  credentials: many(providerCredentials),
  models: many(aiModels),
}));

export const providerCredentialsRelations = relations(providerCredentials, ({ one }) => ({
  provider: one(aiProviders, {
    fields: [providerCredentials.providerId],
    references: [aiProviders.id],
  }),
}));

export const aiModelsRelations = relations(aiModels, ({ one, many }) => ({
  provider: one(aiProviders, {
    fields: [aiModels.providerId],
    references: [aiProviders.id],
  }),
  capabilities: many(modelCapabilities),
}));

export const modelCapabilitiesRelations = relations(modelCapabilities, ({ one }) => ({
  model: one(aiModels, {
    fields: [modelCapabilities.modelId],
    references: [aiModels.id],
  }),
}));
