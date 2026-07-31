-- auto_apply collapses into auto_apply_score: null = nothing auto-approves,
-- 0 = everything does, anything between is a confidence floor.
--
-- A cluster with auto_apply = true approved every proposal regardless of score,
-- which is exactly threshold 0. Its existing auto_apply_score (if any) was dead
-- — the old code took the auto_apply branch and never read it — so overwriting
-- it preserves the behaviour that was actually running.
UPDATE "policies" SET "auto_apply_score" = 0 WHERE "auto_apply" = true;--> statement-breakpoint
ALTER TABLE "policies" DROP COLUMN "auto_apply";
