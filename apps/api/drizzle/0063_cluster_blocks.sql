CREATE TABLE "cluster_blocks" (
	"cluster_id" uuid NOT NULL,
	"task" text NOT NULL,
	"reason" text NOT NULL,
	"detail" text NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cluster_blocks_cluster_id_task_pk" PRIMARY KEY("cluster_id","task")
);
--> statement-breakpoint
ALTER TABLE "cluster_blocks" ADD CONSTRAINT "cluster_blocks_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Carry the four columns on `clusters` over, one row per cluster (#462). They
-- held ONE block for six passes, so there is exactly one to move and the pass it
-- names is whichever failed last. A row written before #408 has no pass at all
-- and lands as `collect`, which is what the dashboard displayed for every block
-- before that column existed.
--
-- The columns themselves are NOT dropped here. The pre-deploy migration runs
-- while the previous image is still serving, and a select of a column that has
-- just gone takes the cluster list down with it — so this migration is the
-- expand and the drop is the contract, one release later.
INSERT INTO "cluster_blocks" ("cluster_id", "task", "reason", "detail", "since")
SELECT
	"id",
	COALESCE("blocked_task", 'collect'),
	"blocked_reason",
	COALESCE("blocked_detail", ''),
	COALESCE("blocked_since", now())
FROM "clusters"
WHERE "blocked_reason" IS NOT NULL
ON CONFLICT DO NOTHING;
