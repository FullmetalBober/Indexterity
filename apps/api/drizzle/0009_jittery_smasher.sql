CREATE TABLE "latency_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"database" text NOT NULL,
	"collection" text NOT NULL,
	"read_ops" bigint NOT NULL,
	"read_latency_micros" bigint NOT NULL,
	"write_ops" bigint NOT NULL,
	"write_latency_micros" bigint NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "latency_samples" ADD CONSTRAINT "latency_samples_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;