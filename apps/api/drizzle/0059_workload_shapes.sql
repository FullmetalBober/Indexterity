CREATE TABLE "workload_shapes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"database" text NOT NULL,
	"collection" text NOT NULL,
	"shape" jsonb NOT NULL,
	"shape_digest" text GENERATED ALWAYS AS (encode(sha256(shape::text::bytea), 'hex')) STORED NOT NULL,
	"executions" bigint NOT NULL,
	"docs_examined" bigint,
	"observed_for_hours" double precision,
	"weekly_docs_examined" bigint,
	"severity" text NOT NULL,
	"clients" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"proposed_index" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"observations" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workload_shapes" ADD CONSTRAINT "workload_shapes_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workload_shapes_identity" ON "workload_shapes" USING btree ("cluster_id","database","collection","shape_digest");--> statement-breakpoint
CREATE INDEX "workload_shapes_cluster_seen" ON "workload_shapes" USING btree ("cluster_id","last_seen_at");