ALTER TABLE "clusters" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "blocked_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "blocked_detail" text;