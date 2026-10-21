CREATE TABLE "article_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canonical_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"http_status" integer,
	"title" text,
	"final_url" text,
	"message" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"site_url" text,
	"repo" text,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"path_template" text DEFAULT 'content/posts/{slug}.md' NOT NULL,
	"preset" text DEFAULT 'generic' NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD COLUMN "draft_hash" text;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "kind" text DEFAULT 'publish' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_drafts" ADD COLUMN "generated_payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_drafts" ADD COLUMN "extras" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_drafts" ADD COLUMN "remote_info" jsonb;--> statement-breakpoint
ALTER TABLE "platform_drafts" ADD COLUMN "published_via" text;--> statement-breakpoint
ALTER TABLE "platform_drafts" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_drafts" ADD COLUMN "edit_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "article_destinations" ADD CONSTRAINT "article_destinations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_destinations" ADD CONSTRAINT "article_destinations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_checks" ADD CONSTRAINT "canonical_checks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_checks" ADD CONSTRAINT "canonical_checks_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "article_destinations_article_platform_idx" ON "article_destinations" USING btree ("owner_id","article_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_checks_article_url_idx" ON "canonical_checks" USING btree ("owner_id","article_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "site_settings_owner_idx" ON "site_settings" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_draft_id_platform_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."platform_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "platform_drafts" SET "generated_payload" = "payload";--> statement-breakpoint
INSERT INTO "article_destinations" ("owner_id", "article_id", "platform", "position") SELECT DISTINCT "owner_id", "article_id", "platform", 0 FROM "platform_drafts" ON CONFLICT DO NOTHING;
