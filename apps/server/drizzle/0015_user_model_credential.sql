CREATE TABLE "user_model_credential" (
	"user_id" text NOT NULL,
	"provider_ref" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" text,
	CONSTRAINT "user_model_credential_user_id_provider_ref_pk" PRIMARY KEY("user_id","provider_ref")
);
--> statement-breakpoint
ALTER TABLE "user_model_credential" ADD CONSTRAINT "user_model_credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_model_credential" ADD CONSTRAINT "user_model_credential_updated_by_admin_id_user_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_model_credential_user_id_idx" ON "user_model_credential" USING btree ("user_id");