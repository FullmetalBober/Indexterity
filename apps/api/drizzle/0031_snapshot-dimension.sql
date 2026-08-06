CREATE TABLE "cluster_indexes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"database" text NOT NULL,
	"collection" text NOT NULL,
	"index_name" text NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_digest" text GENERATED ALWAYS AS (md5(spec::text)) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "index_snapshots_cluster_time";--> statement-breakpoint
DROP INDEX "latency_samples_cluster_time";--> statement-breakpoint
ALTER TABLE "index_snapshots" ADD COLUMN "index_id" uuid;--> statement-breakpoint
ALTER TABLE "index_snapshots" ADD COLUMN "observations" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "latency_samples" ADD COLUMN "observations" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

-- `last_seen_at` arrives nullable and is filled below, rather than arriving with
-- DEFAULT now(). The default is what the generator writes and it would be a lie
-- on every row already in the table: a snapshot from March would come out
-- claiming it was confirmed the instant this migration ran, and that field is
-- precisely what the usage trust gate reads to decide whether we were watching.
-- Filling it deliberately, and only then making it NOT NULL, means no row ever
-- holds a value nobody chose. The column has no default in the schema either, for
-- the same reason — see db/schema.ts.
--
-- An existing row is one observation of one instant, which is a run of one:
-- last_seen_at = captured_at, observations = 1 (the default above).
ALTER TABLE "index_snapshots" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "latency_samples" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
UPDATE "index_snapshots" SET "last_seen_at" = "captured_at";--> statement-breakpoint
UPDATE "latency_samples" SET "last_seen_at" = "captured_at";--> statement-breakpoint
ALTER TABLE "index_snapshots" ALTER COLUMN "last_seen_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "latency_samples" ALTER COLUMN "last_seen_at" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "cluster_indexes" ADD CONSTRAINT "cluster_indexes_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_indexes_identity" ON "cluster_indexes" USING btree ("cluster_id","database","collection","index_name","spec_digest");--> statement-breakpoint
CREATE INDEX "cluster_indexes_cluster" ON "cluster_indexes" USING btree ("cluster_id");--> statement-breakpoint
ALTER TABLE "index_snapshots" ADD CONSTRAINT "index_snapshots_index_id_cluster_indexes_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."cluster_indexes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "index_snapshots_index_time" ON "index_snapshots" USING btree ("index_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "index_snapshots_cluster_time" ON "index_snapshots" USING btree ("cluster_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "latency_samples_cluster_time" ON "latency_samples" USING btree ("cluster_id","last_seen_at");--> statement-breakpoint

-- One dimension row per distinct shape an index has been seen in. Keyed by the
-- spec as well as the identity, so an index that was rebuilt keeps both of its
-- shapes and the older snapshots stay joined to the one they were taken under.
-- created_at is when we first saw that shape, not when this migration ran.
INSERT INTO "cluster_indexes" ("cluster_id", "database", "collection", "index_name", "spec", "created_at")
SELECT "cluster_id", "database", "collection", "index_name", "spec", min("captured_at")
FROM "index_snapshots"
GROUP BY "cluster_id", "database", "collection", "index_name", "spec";--> statement-breakpoint

-- Point the time series at it. Joined on md5(spec::text) rather than on
-- spec = spec because that is what the unique index holds, and jsonb equality
-- over a fat partialFilterExpression is the comparison worth avoiding.
UPDATE "index_snapshots" AS s
SET "index_id" = ci."id"
FROM "cluster_indexes" AS ci
WHERE ci."cluster_id" = s."cluster_id"
  AND ci."database" = s."database"
  AND ci."collection" = s."collection"
  AND ci."index_name" = s."index_name"
  AND ci."spec_digest" = md5(s."spec"::text);
