CREATE TABLE "index_cooldowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"database" text NOT NULL,
	"collection" text NOT NULL,
	"index_name" text NOT NULL,
	"reason" text NOT NULL,
	"regression_count" integer DEFAULT 1 NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "index_cooldowns_target" UNIQUE("cluster_id","database","collection","index_name")
);
--> statement-breakpoint
ALTER TABLE "index_cooldowns" ADD CONSTRAINT "index_cooldowns_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;