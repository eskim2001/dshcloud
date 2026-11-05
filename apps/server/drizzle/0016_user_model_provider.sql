CREATE TABLE "user_model_provider" (
	"user_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"display_name" text,
	"base_url" text NOT NULL,
	"api" text NOT NULL,
	"api_key_env" text NOT NULL,
	"model_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" text
);
--> statement-breakpoint
ALTER TABLE "user_model_provider" ADD CONSTRAINT "user_model_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_model_provider" ADD CONSTRAINT "user_model_provider_updated_by_admin_id_user_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;