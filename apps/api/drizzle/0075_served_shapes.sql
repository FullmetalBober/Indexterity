-- The scanning a build was for (#608): the shapes whose answer the index was, by
-- digest, and the documents they examined a week, recorded when it is built.
-- Both nullable with no default, so every build made before this reads as "not
-- recorded" rather than as a build that answered nothing.
ALTER TABLE "recommendations" ADD COLUMN "served_shape_digests" text[];--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "baseline_weekly_docs_examined" bigint;
