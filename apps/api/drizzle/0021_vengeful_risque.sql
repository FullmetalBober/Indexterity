ALTER TABLE "policies" ADD COLUMN "inferred_window_start_hour" integer;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "inferred_window_end_hour" integer;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "inferred_window_reason" text;