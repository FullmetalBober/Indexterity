ALTER TABLE "policies" ADD COLUMN "workload_analysis" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "target_spec" jsonb;