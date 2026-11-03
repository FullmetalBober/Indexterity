-- When the control plane itself was running (#653): one row per unbroken
-- stretch of ticks. A gap between rows is an outage of ours, which the analysis
-- must not read as a quiet cluster.
--
-- Backfilled from cluster_pass_runs, the per-run history of the hourly passes
-- (14 days): runs less than two hours apart are one stretch, as the tick will
-- judge them (OWN_OUTAGE_MS). On the hosted deployment that recovers the outage
-- this table exists for, 2026-10-31 14:05 to 2026-11-03 11:21 UTC, which the
-- drops hidden through it would otherwise be judged without.
CREATE TABLE "observation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "observation_runs_last_seen" ON "observation_runs" USING btree ("last_seen_at");--> statement-breakpoint
INSERT INTO "observation_runs" ("since", "last_seen_at")
SELECT min("started_at"), max("started_at")
FROM (
  SELECT "started_at",
         sum(CASE WHEN "started_at" - "previous" > interval '2 hours' THEN 1 ELSE 0 END)
           OVER (ORDER BY "started_at") AS "stretch"
  FROM (
    SELECT "started_at", lag("started_at") OVER (ORDER BY "started_at") AS "previous"
    FROM (SELECT DISTINCT "started_at" FROM "cluster_pass_runs") AS "runs"
  ) AS "ordered"
) AS "grouped"
GROUP BY "stretch";
