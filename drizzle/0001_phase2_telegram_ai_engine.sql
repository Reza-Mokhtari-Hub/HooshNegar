CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"request_id" uuid,
	"job_id" uuid,
	"storage_provider" varchar(32) DEFAULT 'local_temp' NOT NULL,
	"object_key" text NOT NULL,
	"mime_type" varchar(120) NOT NULL,
	"file_size_bytes" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN "fallback_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_models" ADD COLUMN "fallback_model_identifier" varchar(200);--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "prompt_preview" text;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "response_preview" text;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "used_fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "telegram_chat_id" bigint;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "status_message_id" integer;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "storage_object_key" text;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD COLUMN "selected_text_model_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD COLUMN "selected_image_model_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD COLUMN "selected_video_model_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD COLUMN "selected_audio_model_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD COLUMN "selected_document_model_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD COLUMN "active_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD COLUMN "system_prompt" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD COLUMN "bot_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_request_id_ai_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."ai_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stored_files_object_key_uidx" ON "stored_files" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "stored_files_expires_idx" ON "stored_files" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "stored_files_user_idx" ON "stored_files" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_fallback_provider_id_ai_providers_id_fk" FOREIGN KEY ("fallback_provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;