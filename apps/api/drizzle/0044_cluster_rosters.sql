CREATE TABLE "cluster_rosters" (
	"cluster_id" uuid PRIMARY KEY NOT NULL,
	"nodes" jsonb NOT NULL,
	"collected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster_rosters" ADD CONSTRAINT "cluster_rosters_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;