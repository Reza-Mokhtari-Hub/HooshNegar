CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended', 'banned', 'pending');--> statement-breakpoint
CREATE TYPE "public"."admin_role" AS ENUM('super_admin', 'admin', 'operator', 'auditor');--> statement-breakpoint
CREATE TYPE "public"."capability_type" AS ENUM('text_generation', 'chat', 'vision', 'image_generation', 'image_editing', 'image_variation', 'audio_transcription', 'speech_generation', 'video_generation', 'embeddings', 'document_analysis');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('untested', 'connected', 'degraded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."model_category" AS ENUM('llm', 'multimodal', 'image', 'audio', 'video', 'embedding', 'document');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'processing', 'succeeded', 'failed', 'refunded', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('free', 'basic', 'pro', 'premium', 'custom');--> statement-breakpoint
CREATE TYPE "public"."provider_type" AS ENUM('openai_compatible', 'google_gemini', 'anthropic', 'replicate', 'fal_ai', 'custom');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'trialing', 'past_due', 'canceled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'in_progress', 'waiting_user', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('grant', 'purchase', 'usage_debit', 'refund', 'referral_bonus', 'adjustment');--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"csrf_token" varchar(128) NOT NULL,
	"ip_address" varchar(64),
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"full_name" varchar(160) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "admin_role" DEFAULT 'admin' NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"last_login_ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" varchar(140) NOT NULL,
	"model_identifier" varchar(200) NOT NULL,
	"category" "model_category" DEFAULT 'llm' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"input_price_per_million" numeric(12, 6) DEFAULT '0' NOT NULL,
	"output_price_per_million" numeric(12, 6) DEFAULT '0' NOT NULL,
	"credit_cost" numeric(12, 4) DEFAULT '1' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"max_input_size" integer DEFAULT 128000 NOT NULL,
	"max_output_size" integer DEFAULT 8192 NOT NULL,
	"model_parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_models_credit_cost_non_negative" CHECK ("ai_models"."credit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"provider_type" "provider_type" NOT NULL,
	"base_url" text NOT NULL,
	"organization_id" varchar(160),
	"additional_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connection_status" "connection_status" DEFAULT 'untested' NOT NULL,
	"last_test_message" text,
	"last_test_latency_ms" integer,
	"last_tested_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_providers_priority_non_negative" CHECK ("ai_providers"."priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" uuid,
	"model_id" uuid,
	"conversation_id" uuid,
	"capability" "capability_type" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"credits_charged" numeric(12, 4) DEFAULT '0' NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"error_code" varchar(64),
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid,
	"actor_email" varchar(255),
	"action" varchar(120) NOT NULL,
	"resource_type" varchar(80) NOT NULL,
	"resource_id" varchar(128),
	"severity" varchar(24) DEFAULT 'info' NOT NULL,
	"status" varchar(24) DEFAULT 'success' NOT NULL,
	"ip_address" varchar(64),
	"user_agent" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(24) NOT NULL,
	"content" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_account_id" uuid,
	"model_id" uuid,
	"title" varchar(200) DEFAULT 'گفتگوی جدید' NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"discount_type" varchar(24) DEFAULT 'percentage' NOT NULL,
	"discount_value" numeric(12, 2) NOT NULL,
	"max_redemptions" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "transaction_type" NOT NULL,
	"amount" numeric(16, 4) NOT NULL,
	"balance_after" numeric(16, 4) NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"reference_type" varchar(64),
	"reference_id" varchar(128),
	"description" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"balance" numeric(16, 4) DEFAULT '0' NOT NULL,
	"reserved_balance" numeric(16, 4) DEFAULT '0' NOT NULL,
	"lifetime_earned" numeric(16, 4) DEFAULT '0' NOT NULL,
	"lifetime_spent" numeric(16, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_wallets_balance_non_negative" CHECK ("credit_wallets"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_job_id" varchar(200),
	"capability" "capability_type" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"result_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_jobs_progress_range" CHECK ("generation_jobs"."progress_percent" >= 0 AND "generation_jobs"."progress_percent" <= 100)
);
--> statement-breakpoint
CREATE TABLE "model_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"capability" "capability_type" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid,
	"gateway" varchar(64) NOT NULL,
	"gateway_ref_id" varchar(200),
	"amount" numeric(14, 2) NOT NULL,
	"currency" varchar(16) DEFAULT 'IRR' NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_non_negative" CHECK ("payments"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"label" varchar(120) DEFAULT 'primary' NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"iv" varchar(64) NOT NULL,
	"auth_tag" varchar(64) NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"masked_preview" varchar(64) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"code" varchar(48) NOT NULL,
	"reward_credits" integer DEFAULT 50 NOT NULL,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_code_id" uuid NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"referred_user_id" uuid NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"relationship_id" uuid NOT NULL,
	"beneficiary_user_id" uuid NOT NULL,
	"credits_awarded" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"awarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"tier" "plan_tier" DEFAULT 'custom' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(16) DEFAULT 'IRR' NOT NULL,
	"duration_days" integer DEFAULT 30 NOT NULL,
	"available_model_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"daily_request_limit" integer DEFAULT 50 NOT NULL,
	"monthly_request_limit" integer DEFAULT 1000 NOT NULL,
	"text_generation_limit" integer DEFAULT 1000 NOT NULL,
	"image_generation_limit" integer DEFAULT 20 NOT NULL,
	"audio_generation_limit" integer DEFAULT 10 NOT NULL,
	"video_generation_limit" integer DEFAULT 0 NOT NULL,
	"max_file_size_mb" integer DEFAULT 10 NOT NULL,
	"max_concurrent_tasks" integer DEFAULT 2 NOT NULL,
	"credit_allocation" integer DEFAULT 100 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_duration_positive" CHECK ("subscription_plans"."duration_days" > 0),
	CONSTRAINT "subscription_plans_price_non_negative" CHECK ("subscription_plans"."price_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"assigned_admin_id" uuid,
	"subject" varchar(200) NOT NULL,
	"message" text NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'medium' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"setting_key" varchar(120) NOT NULL,
	"value" jsonb NOT NULL,
	"category" varchar(64) DEFAULT 'general' NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"updated_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_chat_id" bigint,
	"username" varchar(128),
	"first_name" varchar(128),
	"last_name" varchar(128),
	"language_code" varchar(16) DEFAULT 'fa',
	"is_blocked_by_user" boolean DEFAULT false NOT NULL,
	"is_premium_telegram" boolean DEFAULT false NOT NULL,
	"last_interaction_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_bot_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" varchar(32) DEFAULT 'primary' NOT NULL,
	"encrypted_bot_token" text,
	"token_iv" varchar(64),
	"token_auth_tag" varchar(64),
	"masked_bot_token" varchar(64),
	"bot_username" varchar(128) DEFAULT '' NOT NULL,
	"bot_display_name" varchar(160) DEFAULT '' NOT NULL,
	"webhook_url" text DEFAULT '' NOT NULL,
	"encrypted_webhook_secret" text,
	"webhook_secret_iv" varchar(64),
	"webhook_secret_auth_tag" varchar(64),
	"masked_webhook_secret" varchar(64),
	"is_active" boolean DEFAULT false NOT NULL,
	"welcome_message" text DEFAULT 'خوش آمدید! برای شروع گفتگو با هوش مصنوعی پیام خود را ارسال کنید.' NOT NULL,
	"default_language" varchar(16) DEFAULT 'fa' NOT NULL,
	"support_username" varchar(128) DEFAULT '' NOT NULL,
	"default_model_id" uuid,
	"error_messages" jsonb DEFAULT '{"rateLimit":"تعداد درخواست‌های شما به حد مجاز رسیده است. لطفاً کمی بعد تلاش کنید.","maintenance":"سامانه در حال به‌روزرسانی است. به زودی بازمی‌گردیم.","providerError":"خطایی در پردازش هوش مصنوعی رخ داد. لطفاً مجدداً تلاش کنید.","insufficientCredits":"اعتبار حساب شما کافی نیست. لطفاً اشتراک یا اعتبار خود را تمدید کنید.","unsupportedCapability":"مدل انتخاب‌شده از این قابلیت پشتیبانی نمی‌کند."}'::jsonb NOT NULL,
	"connection_status" "connection_status" DEFAULT 'untested' NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_bot_settings_singleton_key_unique" UNIQUE("singleton_key")
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" uuid,
	"model_id" uuid,
	"request_id" uuid,
	"capability" "capability_type" NOT NULL,
	"units_consumed" integer DEFAULT 1 NOT NULL,
	"credits_consumed" numeric(12, 4) DEFAULT '0' NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"recorded_date" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" uuid,
	"capability" "capability_type" NOT NULL,
	"quota_limit" integer DEFAULT 0 NOT NULL,
	"quota_used" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_entitlements_quota_non_negative" CHECK ("user_entitlements"."quota_used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" varchar(160),
	"first_name" varchar(100),
	"last_name" varchar(100),
	"avatar_url" text,
	"timezone" varchar(64) DEFAULT 'Asia/Tehran' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_uid" varchar(128),
	"email" varchar(255),
	"phone_number" varchar(32),
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"locale" varchar(16) DEFAULT 'fa' NOT NULL,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" varchar(64) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"idempotency_key" varchar(180) NOT NULL,
	"status" varchar(32) DEFAULT 'received' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_telegram_account_id_telegram_accounts_id_fk" FOREIGN KEY ("telegram_account_id") REFERENCES "public"."telegram_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_request_id_ai_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."ai_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_capabilities" ADD CONSTRAINT "model_capabilities_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_relationships" ADD CONSTRAINT "referral_relationships_referral_code_id_referral_codes_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_relationships" ADD CONSTRAINT "referral_relationships_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_relationships" ADD CONSTRAINT "referral_relationships_referred_user_id_users_id_fk" FOREIGN KEY ("referred_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_relationship_id_referral_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."referral_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_beneficiary_user_id_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_admin_id_admin_users_id_fk" FOREIGN KEY ("assigned_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_admin_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bot_settings" ADD CONSTRAINT "telegram_bot_settings_default_model_id_ai_models_id_fk" FOREIGN KEY ("default_model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_request_id_ai_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."ai_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_entitlements" ADD CONSTRAINT "user_entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_entitlements" ADD CONSTRAINT "user_entitlements_subscription_id_user_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."user_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_sessions_token_hash_uidx" ON "admin_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_sessions_admin_user_idx" ON "admin_sessions" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "admin_sessions_expires_at_idx" ON "admin_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_uidx" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "admin_users_role_status_idx" ON "admin_users" USING btree ("role","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_models_provider_identifier_uidx" ON "ai_models" USING btree ("provider_id","model_identifier");--> statement-breakpoint
CREATE INDEX "ai_models_active_priority_idx" ON "ai_models" USING btree ("is_active","priority");--> statement-breakpoint
CREATE INDEX "ai_models_category_idx" ON "ai_models" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_providers_slug_uidx" ON "ai_providers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ai_providers_active_priority_idx" ON "ai_providers" USING btree ("is_active","priority");--> statement-breakpoint
CREATE INDEX "ai_providers_type_idx" ON "ai_providers" USING btree ("provider_type");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_requests_idempotency_uidx" ON "ai_requests" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ai_requests_user_created_idx" ON "ai_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_requests_provider_model_idx" ON "ai_requests" USING btree ("provider_id","model_id");--> statement-breakpoint
CREATE INDEX "ai_requests_status_created_idx" ON "ai_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_admin_idx" ON "audit_logs" USING btree ("admin_user_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_conv_created_idx" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_user_updated_idx" ON "conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_code_uidx" ON "coupons" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_transactions_idempotency_uidx" ON "credit_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_transactions_wallet_created_idx" ON "credit_transactions" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_transactions_user_created_idx" ON "credit_transactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_wallets_user_id_uidx" ON "credit_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_status_idx" ON "generation_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "generation_jobs_request_idx" ON "generation_jobs" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_capabilities_model_cap_uidx" ON "model_capabilities" USING btree ("model_id","capability");--> statement-breakpoint
CREATE INDEX "model_capabilities_cap_idx" ON "model_capabilities" USING btree ("capability");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_idempotency_uidx" ON "payment_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_events_payment_idx" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_uidx" ON "payments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_user_status_idx" ON "payments" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "payments_created_idx" ON "payments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "provider_credentials_provider_active_idx" ON "provider_credentials" USING btree ("provider_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_code_uidx" ON "referral_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "referral_codes_owner_idx" ON "referral_codes" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_relationships_referred_uidx" ON "referral_relationships" USING btree ("referred_user_id");--> statement-breakpoint
CREATE INDEX "referral_relationships_referrer_idx" ON "referral_relationships" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_rewards_idempotency_uidx" ON "referral_rewards" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "referral_rewards_beneficiary_idx" ON "referral_rewards" USING btree ("beneficiary_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_plans_slug_uidx" ON "subscription_plans" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "subscription_plans_tier_enabled_idx" ON "subscription_plans" USING btree ("tier","is_enabled");--> statement-breakpoint
CREATE INDEX "support_tickets_status_priority_idx" ON "support_tickets" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX "support_tickets_user_idx" ON "support_tickets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "system_settings_key_uidx" ON "system_settings" USING btree ("setting_key");--> statement-breakpoint
CREATE INDEX "system_settings_category_idx" ON "system_settings" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_accounts_tg_user_uidx" ON "telegram_accounts" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE INDEX "telegram_accounts_user_idx" ON "telegram_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "telegram_accounts_username_idx" ON "telegram_accounts" USING btree ("username");--> statement-breakpoint
CREATE INDEX "usage_records_date_idx" ON "usage_records" USING btree ("recorded_date");--> statement-breakpoint
CREATE INDEX "usage_records_user_date_idx" ON "usage_records" USING btree ("user_id","recorded_date");--> statement-breakpoint
CREATE INDEX "usage_records_model_idx" ON "usage_records" USING btree ("model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_entitlements_user_cap_uidx" ON "user_entitlements" USING btree ("user_id","capability");--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_user_id_uidx" ON "user_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_subscriptions_user_status_idx" ON "user_subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "user_subscriptions_ends_at_idx" ON "user_subscriptions" USING btree ("ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uidx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_uid_uidx" ON "users" USING btree ("external_uid");--> statement-breakpoint
CREATE INDEX "users_status_created_idx" ON "users" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_idempotency_uidx" ON "webhook_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "webhook_events_source_status_idx" ON "webhook_events" USING btree ("source","status");