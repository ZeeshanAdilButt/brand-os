CREATE TABLE "connect_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"kind" text NOT NULL,
	"state_hash" text,
	"session_hash" text NOT NULL,
	"redirect_uri" text,
	"code_verifier_enc" text,
	"device_code_enc" text,
	"user_code" text,
	"verification_uri" text,
	"interval_sec" integer,
	"next_poll_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"instance" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "platform_connections" ADD COLUMN "auth_kind" text;--> statement-breakpoint
ALTER TABLE "platform_connections" ADD COLUMN "scopes_granted" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connections" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_connections" ADD COLUMN "renewable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connections" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "platform_connections" ADD COLUMN "refresh_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_connections" ADD COLUMN "refresh_lock_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connect_flows" ADD CONSTRAINT "connect_flows_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connect_flows_owner_status_idx" ON "connect_flows" USING btree ("owner_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connect_flows_owner_state_idx" ON "connect_flows" USING btree ("owner_id","state_hash") WHERE "connect_flows"."state_hash" is not null;