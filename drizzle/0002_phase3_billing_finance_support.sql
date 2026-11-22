ALTER TYPE "public"."plan_tier" ADD VALUE IF NOT EXISTS 'enterprise';--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE IF NOT EXISTS 'pending';--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE IF NOT EXISTS 'suspended';--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE IF NOT EXISTS 'payment_failed';--> statement-breakpoint
ALTER TYPE "public"."transaction_type" ADD VALUE IF NOT EXISTS 'subscription_credit';--> statement-breakpoint
ALTER TYPE "public"."transaction_type" ADD VALUE IF NOT EXISTS 'promotional_credit';--> statement-breakpoint

ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "min_credit_cost" numeric(12, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "provider_cost_per_op_usd" numeric(12, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "allowed_plan_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "stars_price" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "billing_interval" varchar(24) DEFAULT 'monthly' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "is_recurring_stars" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "allowed_provider_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "daily_text_limit" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "daily_image_limit" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "daily_video_limit" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "max_context_length" integer DEFAULT 16000 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "priority_queue" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "features" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "restrictions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ALTER COLUMN "currency" SET DEFAULT 'XTR';--> statement-breakpoint

ALTER TABLE "user_subscriptions" ADD COLUMN IF NOT EXISTS "telegram_charge_id" varchar(200);--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN IF NOT EXISTS "last_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN IF NOT EXISTS "canceled_reason" text;--> statement-breakpoint

ALTER TABLE "credit_wallets" DROP CONSTRAINT IF EXISTS "credit_wallets_balance_non_negative";--> statement-breakpoint

ALTER TABLE "credit_transactions" ADD COLUMN IF NOT EXISTS "balance_before" numeric(16, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN IF NOT EXISTS "related_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN IF NOT EXISTS "related_request_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN IF NOT EXISTS "related_subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD COLUMN IF NOT EXISTS "admin_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_transactions_admin_user_id_admin_users_id_fk') THEN
    ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "credit_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"credits_amount" integer NOT NULL,
	"bonus_credits" integer DEFAULT 0 NOT NULL,
	"stars_price" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_packages_stars_positive" CHECK ("credit_packages"."stars_price" >= 1),
	CONSTRAINT "credit_packages_credits_positive" CHECK ("credit_packages"."credits_amount" >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_packages_slug_uidx" ON "credit_packages" USING btree ("slug");--> statement-breakpoint

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "order_number" varchar(64);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "telegram_user_id" bigint;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "credit_package_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "payment_type" varchar(32) DEFAULT 'subscription' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "invoice_payload" varchar(160);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "invoice_payload_hmac" varchar(128);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "telegram_payment_charge_id" varchar(200);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "provider_payment_charge_id" varchar(200);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "is_recurring" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "is_first_recurring" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "subscription_expiration_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "refund_status" varchar(32) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "refund_reason" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "gateway" SET DEFAULT 'telegram_stars';--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "currency" SET DEFAULT 'XTR';--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_credit_package_id_credit_packages_id_fk') THEN
    ALTER TABLE "payments" ADD CONSTRAINT "payments_credit_package_id_credit_packages_id_fk" FOREIGN KEY ("credit_package_id") REFERENCES "public"."credit_packages"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_order_number_uidx" ON "payments" USING btree ("order_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_tg_charge_uidx" ON "payments" USING btree ("telegram_payment_charge_id");--> statement-breakpoint

ALTER TABLE "referral_relationships" ADD COLUMN IF NOT EXISTS "qualified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_relationships" ADD COLUMN IF NOT EXISTS "qualifying_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "referral_relationships" ADD COLUMN IF NOT EXISTS "fraud_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_relationships" ADD COLUMN IF NOT EXISTS "fraud_flags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_relationships_qualifying_payment_id_payments_id_fk') THEN
    ALTER TABLE "referral_relationships" ADD CONSTRAINT "referral_relationships_qualifying_payment_id_payments_id_fk" FOREIGN KEY ("qualifying_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "referral_rewards" ADD COLUMN IF NOT EXISTS "reward_type" varchar(32) DEFAULT 'credits' NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD COLUMN IF NOT EXISTS "subscription_days_awarded" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD COLUMN IF NOT EXISTS "related_payment_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_rewards_related_payment_id_payments_id_fk') THEN
    ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_related_payment_id_payments_id_fk" FOREIGN KEY ("related_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "referral_program_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" varchar(32) DEFAULT 'primary' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"inviter_reward_type" varchar(32) DEFAULT 'credits' NOT NULL,
	"inviter_bonus_credits" integer DEFAULT 50 NOT NULL,
	"inviter_free_days" integer DEFAULT 0 NOT NULL,
	"invited_bonus_credits" integer DEFAULT 25 NOT NULL,
	"require_purchase" boolean DEFAULT false NOT NULL,
	"min_purchase_stars" integer DEFAULT 0 NOT NULL,
	"min_plan_tier" varchar(32) DEFAULT 'free' NOT NULL,
	"max_referrals_per_account" integer DEFAULT 100 NOT NULL,
	"max_reward_credits_per_account" integer DEFAULT 10000 NOT NULL,
	"fraud_velocity_limit_per_hour" integer DEFAULT 10 NOT NULL,
	"campaign_starts_at" timestamp with time zone,
	"campaign_ends_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_program_settings_singleton_key_unique" UNIQUE("singleton_key")
);--> statement-breakpoint

ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "per_user_limit" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "min_stars_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "applicable_plan_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "starts_at" timestamp with time zone;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "coupon_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coupon_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"payment_id" uuid,
	"credits_awarded" integer DEFAULT 0 NOT NULL,
	"discount_applied" numeric(12, 2) DEFAULT '0' NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "coupon_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "coupon_redemptions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coupon_redemptions_idempotency_uidx" ON "coupon_redemptions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coupon_redemptions_coupon_user_idx" ON "coupon_redemptions" USING btree ("coupon_id","user_id");--> statement-breakpoint

ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "category" varchar(32) DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "related_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "related_request_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "admin_reply" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "replied_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_tickets_related_payment_id_payments_id_fk') THEN
    ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_related_payment_id_payments_id_fk" FOREIGN KEY ("related_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_tickets_related_request_id_ai_requests_id_fk') THEN
    ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_related_request_id_ai_requests_id_fk" FOREIGN KEY ("related_request_id") REFERENCES "public"."ai_requests"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_category_idx" ON "support_tickets" USING btree ("category");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_key" varchar(64) NOT NULL,
	"title_fa" varchar(160) NOT NULL,
	"body_fa" text NOT NULL,
	"body_en" text DEFAULT '' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"updated_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_templates_updated_by_admin_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_templates_key_uidx" ON "notification_templates" USING btree ("template_key");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"telegram_chat_id" bigint,
	"template_key" varchar(64) NOT NULL,
	"dedup_key" varchar(200) NOT NULL,
	"channel" varchar(32) DEFAULT 'telegram' NOT NULL,
	"message_text" text NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"error_message" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_logs_dedup_uidx" ON "notification_logs" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_logs_user_created_idx" ON "notification_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_logs_template_idx" ON "notification_logs" USING btree ("template_key");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "user_limit_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"daily_request_limit" integer,
	"monthly_request_limit" integer,
	"daily_text_limit" integer,
	"daily_image_limit" integer,
	"daily_video_limit" integer,
	"max_concurrent_tasks" integer,
	"reason" text DEFAULT '' NOT NULL,
	"updated_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_limit_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "user_limit_overrides_updated_by_admin_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_limit_overrides_user_uidx" ON "user_limit_overrides" USING btree ("user_id");
