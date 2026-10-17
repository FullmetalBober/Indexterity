-- A week of pass durations per cluster (#639): every run of the hourly passes,
-- without phases, pruned at two weeks by the retention sweep. The last run of
-- every pass stays in cluster_pass_timings as before.
CREATE TABLE "cluster_pass_runs" (
	"cluster_id" uuid NOT NULL,
	"task" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "cluster_pass_runs_cluster_id_task_started_at_pk" PRIMARY KEY("cluster_id","task","started_at")
);
--> statement-breakpoint
ALTER TABLE "cluster_pass_runs" ADD CONSTRAINT "cluster_pass_runs_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;