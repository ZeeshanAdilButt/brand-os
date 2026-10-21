CREATE TABLE "ai_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"article_id" uuid NOT NULL,
	"sel_start" integer,
	"sel_end" integer,
	"excerpt" text NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"provider_id" uuid,
	"provider_kind" text,
	"provider_name" text,
	"model" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"article_revision" integer NOT NULL,
	"prompt_text" text,
	"prompt_sha256" text,
	"request_hash" text,
	"approved_item_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"context_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"withheld_count" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"tokens_estimated" boolean DEFAULT true NOT NULL,
	"from_cache" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_tasks_owner_article_idx" ON "ai_tasks" USING btree ("owner_id","article_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_tasks_owner_status_idx" ON "ai_tasks" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "ai_tasks_owner_hash_idx" ON "ai_tasks" USING btree ("owner_id","request_hash");