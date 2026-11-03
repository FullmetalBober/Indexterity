-- When the control plane itself was running (#653): one row per unbroken
-- stretch of ticks. A gap between rows is an outage of ours, which the analysis
-- must not read as a quiet cluster. Starts empty; the first tick writes a row.
CREATE TABLE "observation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "observation_runs_last_seen" ON "observation_runs" USING btree ("last_seen_at");