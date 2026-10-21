-- Hand-written: array_to_string is only STABLE, and a generated column needs an IMMUTABLE expression.
-- For text[] input the result does not depend on any setting, so declaring it immutable is safe.
CREATE FUNCTION "cph_join_tags"(text[]) RETURNS text
	LANGUAGE sql IMMUTABLE PARALLEL SAFE
	AS $$ SELECT array_to_string($1, ' ') $$;
--> statement-breakpoint
CREATE TABLE "brand_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"tone" text,
	"audience" text,
	"writing_style" text,
	"avoid" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"source_id" uuid,
	"seed_key" text,
	"kind" text DEFAULT 'note' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_date" date,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"confidentiality" text DEFAULT 'private' NOT NULL,
	"public_use_permitted" boolean DEFAULT false NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B') || setweight(to_tsvector('english', coalesce(cph_join_tags(tags), '')), 'C')) STORED
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"seed_key" text,
	"kind" text DEFAULT 'manual' NOT NULL,
	"title" text NOT NULL,
	"uri" text,
	"source_date" date,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"headline" text,
	"years_experience" integer,
	"location" text,
	"career_goals" text,
	"target_employers" text[] DEFAULT '{}'::text[] NOT NULL,
	"expertise_areas" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_preferences" ADD CONSTRAINT "brand_preferences_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_preferences_owner_idx" ON "brand_preferences" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "knowledge_items_owner_updated_idx" ON "knowledge_items" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "knowledge_items_owner_status_idx" ON "knowledge_items" USING btree ("owner_id","verification_status");--> statement-breakpoint
CREATE INDEX "knowledge_items_search_idx" ON "knowledge_items" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_items_owner_seed_idx" ON "knowledge_items" USING btree ("owner_id","seed_key");--> statement-breakpoint
CREATE INDEX "knowledge_sources_owner_imported_idx" ON "knowledge_sources" USING btree ("owner_id","imported_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_owner_seed_idx" ON "knowledge_sources" USING btree ("owner_id","seed_key");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_owner_idx" ON "profiles" USING btree ("owner_id");