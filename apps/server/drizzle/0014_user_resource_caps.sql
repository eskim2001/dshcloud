ALTER TABLE "user" ADD COLUMN "cpu_quota" real;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "memory_mb_quota" integer;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "pids_quota" integer;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "disk_mb_quota" integer;