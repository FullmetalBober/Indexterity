-- Where Indexterity has turned a cluster's profiler on for the drops in flight
-- (#596). The watch's own state lives in the profiler filter on the cluster; this
-- is only the list of databases to look at once nothing needs it, so the filter
-- can be given back. A new table, so nothing existing changes shape.
CREATE TABLE "failure_watches" (
	"cluster_id" uuid NOT NULL,
	"database" text NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "failure_watches_cluster_id_database_pk" PRIMARY KEY("cluster_id","database")
);
--> statement-breakpoint
ALTER TABLE "failure_watches" ADD CONSTRAINT "failure_watches_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;