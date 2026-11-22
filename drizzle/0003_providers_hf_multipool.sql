ALTER TYPE "public"."provider_type" ADD VALUE IF NOT EXISTS 'huggingface';--> statement-breakpoint
ALTER TYPE "public"."provider_type" ADD VALUE IF NOT EXISTS 'huggingface_space';--> statement-breakpoint

ALTER TABLE "provider_credentials" ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN IF NOT EXISTS "status" varchar(32) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN IF NOT EXISTS "cooldown_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN IF NOT EXISTS "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN IF NOT EXISTS "last_error_code" varchar(64);--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN IF NOT EXISTS "last_error_message" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_credentials_pool_order_idx" ON "provider_credentials" USING btree ("provider_id","is_active","priority");
