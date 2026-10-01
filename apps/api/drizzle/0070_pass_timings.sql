-- How long each pass last took against each cluster, and how it ended (#571).
--
-- One row per (cluster, pass), overwritten by the next run, so the table holds
-- six rows per cluster whatever the cadence. Additive: nothing reads it until
-- this release's api does, and an older api never writes it.
CREATE TABLE "cluster_pass_timings" (
	"cluster_id" uuid NOT NULL,
	"task" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"budget_ms" integer,
	"phases" jsonb NOT NULL,
	CONSTRAINT "cluster_pass_timings_cluster_id_task_pk" PRIMARY KEY("cluster_id","task")
);
--> statement-breakpoint
ALTER TABLE "cluster_pass_timings" ADD CONSTRAINT "cluster_pass_timings_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;