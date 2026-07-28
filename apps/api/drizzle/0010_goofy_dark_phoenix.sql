ALTER TABLE "recommendations" ADD COLUMN "built_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "baseline_write_ops" bigint;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "baseline_write_latency" bigint;