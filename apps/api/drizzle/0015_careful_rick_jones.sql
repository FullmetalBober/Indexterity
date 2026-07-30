ALTER TABLE "policies" ADD COLUMN "auto_apply_score" integer;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "score" integer DEFAULT 0 NOT NULL;