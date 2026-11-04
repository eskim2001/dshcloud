ALTER TABLE "instance" ADD COLUMN "last_active_at" timestamp with time zone DEFAULT now() NOT NULL;
