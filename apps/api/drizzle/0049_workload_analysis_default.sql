ALTER TABLE "policies" ALTER COLUMN "workload_analysis" SET DEFAULT true;--> statement-breakpoint
-- Existing rows too, not only the ones written from here on (#258).
--
-- A stored `false` was never a customer's choice: the column defaulted to it and
-- the dashboard's toggle had no state distinguishing "off" from "never
-- configured", so the two are indistinguishable in the data and the honest reading
-- is the one that matches the new default. Every plan entitles the feature, FREE
-- and self-host included, so nothing here is being given away.
--
-- Safe to do in bulk because turning it on PROPOSES and never builds: the create
-- side writes CREATE/UPDATE/MERGE recommendation rows, and building them is gated
-- separately on `instant_create`, which is untouched and still defaults to false.
-- Nothing reaches anybody's cluster as a write. A cluster that genuinely wants it
-- off turns it off on its Settings tab, and that choice now records itself.
UPDATE "policies" SET "workload_analysis" = true WHERE "workload_analysis" = false;
