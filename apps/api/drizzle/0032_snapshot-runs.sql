-- The contract half of 0031. Safe to run straight after it: every snapshot row
-- got an index_id there, because the dimension rows were derived from these very
-- rows and so each one has exactly one match.
ALTER TABLE "index_snapshots" ALTER COLUMN "index_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "index_snapshots" DROP COLUMN "database";--> statement-breakpoint
ALTER TABLE "index_snapshots" DROP COLUMN "collection";--> statement-breakpoint
ALTER TABLE "index_snapshots" DROP COLUMN "index_name";--> statement-breakpoint
ALTER TABLE "index_snapshots" DROP COLUMN "spec";