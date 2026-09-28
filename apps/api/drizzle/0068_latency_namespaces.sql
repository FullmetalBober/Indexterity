-- The namespace, stored once per cluster instead of on every latency row (#551).
--
-- EXPAND. The contract half, dropping `database`, `collection` and the stored
-- `span`, is 0069, and the backfill sits between them. Two files because
-- drizzle-kit cannot generate a table's added and dropped columns in one pass
-- without prompting.
--
-- This file also carries no copy of 0066's four `index_snapshots` columns,
-- although the generator emitted them. 0066 and 0067 were written by hand with
-- no snapshot beside them, so the generator diffed against 0065's and put 0066
-- in again. Those columns exist, and the snapshot written with THIS file is the
-- first to describe them, which closes that gap for the next generate.
CREATE TABLE "cluster_namespaces" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cluster_namespaces_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"cluster_id" uuid NOT NULL,
	"database" text NOT NULL,
	"collection" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster_namespaces" ADD CONSTRAINT "cluster_namespaces_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_namespaces_identity" ON "cluster_namespaces" USING btree ("cluster_id","database","collection");--> statement-breakpoint
ALTER TABLE "latency_samples" ADD COLUMN "namespace_id" integer;--> statement-breakpoint

-- One dimension row per namespace the table has ever held, dated to its first
-- sample, the way 0031 dated `cluster_indexes`: `created_at` is when we first
-- read that namespace, not when this migration ran. Retention prunes a
-- namespace older than its plan's window once nothing references it, so a row
-- dated to the migration would outlive its history by however long ago that was.
INSERT INTO "cluster_namespaces" ("cluster_id", "database", "collection", "created_at")
SELECT "cluster_id", "database", "collection", min("captured_at")
FROM "latency_samples"
GROUP BY "cluster_id", "database", "collection";--> statement-breakpoint

-- The column stays empty here. 0069 fills it in the same pass that drops the
-- text columns, which is one rewrite of the table rather than an UPDATE of every
-- row followed by a rewrite. The UPDATE would also leave a dead copy of each row
-- that vacuum only ever marks reusable, on a database billed for its size.
ALTER TABLE "latency_samples" ADD CONSTRAINT "latency_samples_namespace_id_cluster_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."cluster_namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "latency_samples_namespace_time" ON "latency_samples" USING btree ("namespace_id","captured_at" DESC NULLS LAST);
