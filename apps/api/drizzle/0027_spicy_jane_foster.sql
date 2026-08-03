CREATE TYPE "public"."recommendation_source" AS ENUM('CLASSIFY', 'WORKLOAD', 'RETIRE');--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "source" "recommendation_source" DEFAULT 'CLASSIFY' NOT NULL;--> statement-breakpoint
-- Backfill: the column defaults to CLASSIFY, but rows already in the table were
-- authored by whichever job matched the old delete scopes. suggest.ts cleared
-- CREATE/UPDATE/MERGE plus its two advisory name patterns; everything else was
-- classify's. Getting this wrong would make one pass either orphan its old rows
-- or delete another job's.
UPDATE "recommendations" SET "source" = 'WORKLOAD'
WHERE "type" IN ('CREATE', 'UPDATE', 'MERGE')
   OR "index_name" LIKE '%\_ttl' OR "index_name" LIKE '%\_sortorder';
