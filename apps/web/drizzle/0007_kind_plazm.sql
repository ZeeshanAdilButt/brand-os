CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"payload_sha256" text NOT NULL,
	"tag" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text DEFAULT 'owner' NOT NULL,
	"checked" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"invalid_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"encrypted_key" text NOT NULL,
	"key_last4" text NOT NULL,
	"status" text DEFAULT 'unchecked' NOT NULL,
	"who" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_check_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"connection_id" uuid,
	"account" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"tag_report" jsonb NOT NULL,
	"lint" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_revision" integer NOT NULL,
	"source_hash" text NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"remote_id" text,
	"remote_url" text,
	"remote_preview_url" text,
	"failure_kind" text,
	"failure_message" text,
	"next_action" text,
	"staged_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"payload_sha256" text NOT NULL,
	"approval_id" uuid,
	"http_status" integer,
	"error_kind" text,
	"message" text,
	"remote_id" text,
	"remote_url" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_draft_id_platform_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."platform_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_connections" ADD CONSTRAINT "platform_connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_drafts" ADD CONSTRAINT "platform_drafts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_drafts" ADD CONSTRAINT "platform_drafts_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_drafts" ADD CONSTRAINT "platform_drafts_connection_id_platform_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."platform_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_draft_id_platform_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."platform_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_owner_draft_idx" ON "approvals" USING btree ("owner_id","draft_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_connections_owner_platform_idx" ON "platform_connections" USING btree ("owner_id","platform");--> statement-breakpoint
CREATE INDEX "platform_drafts_owner_article_idx" ON "platform_drafts" USING btree ("owner_id","article_id","platform");--> statement-breakpoint
CREATE INDEX "platform_drafts_owner_status_idx" ON "platform_drafts" USING btree ("owner_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_drafts_out_once_idx" ON "platform_drafts" USING btree ("owner_id","platform","payload_sha256") WHERE "platform_drafts"."status" in ('publishing', 'unknown', 'published');--> statement-breakpoint
CREATE INDEX "publish_attempts_owner_draft_idx" ON "publish_attempts" USING btree ("owner_id","draft_id","started_at");