-- The cluster's total index bytes per day, written by every collect (#640). The
-- footprint chart prefers these rows and derives a day without one from the
-- snapshot runs, as it did before, so nothing is backfilled.
CREATE TABLE "cluster_footprint_days" (
	"cluster_id" uuid NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"total_bytes" bigint NOT NULL,
	"index_count" integer NOT NULL,
	CONSTRAINT "cluster_footprint_days_cluster_id_day_pk" PRIMARY KEY("cluster_id","day")
);
--> statement-breakpoint
ALTER TABLE "cluster_footprint_days" ADD CONSTRAINT "cluster_footprint_days_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;