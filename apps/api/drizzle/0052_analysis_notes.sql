CREATE TABLE "analysis_notes" (
	"cluster_id" uuid NOT NULL,
	"source" "recommendation_source" NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"considered_indexes" integer DEFAULT 0 NOT NULL,
	"trusted_indexes" integer DEFAULT 0 NOT NULL,
	"refusals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"suppressed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "analysis_notes_cluster_id_source_pk" PRIMARY KEY("cluster_id","source")
);
--> statement-breakpoint
ALTER TABLE "analysis_notes" ADD CONSTRAINT "analysis_notes_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;