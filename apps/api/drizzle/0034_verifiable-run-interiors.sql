-- The digest moves from md5 to sha256. Not for secrecy — nobody is attacking
-- this — but because a collision silently MERGES two different index shapes into
-- one dimension row, and every snapshot of one would then be reported under the
-- other's spec. Negligible odds either way; md5's are reachable by construction
-- and the landing is silent, which is the wrong trade against 32 bytes on a table
-- holding a few hundred rows.
--
-- Hand-corrected from the generated version, which emitted the drop and the add
-- but not the index. `cluster_indexes_identity` is UNIQUE on
-- (cluster_id, database, collection, index_name, spec_digest), so dropping the
-- column takes the index with it — and re-adding the column does not bring it
-- back. Applying that as generated would have quietly removed the uniqueness the
-- dimension upsert depends on: the collector reads a shape, finds nothing, and
-- inserts a duplicate, which is the row-per-collect behaviour this whole change
-- exists to stop.
--
-- Not `ALTER COLUMN ... SET EXPRESSION`, which would keep the index and is tidier,
-- because it needs Postgres 17. The chart points at a managed instance the operator
-- chose, so a migration that assumes a major version is a migration that fails on
-- someone else's cluster.
DROP INDEX IF EXISTS "cluster_indexes_identity";--> statement-breakpoint
ALTER TABLE "cluster_indexes" drop column "spec_digest";--> statement-breakpoint
ALTER TABLE "cluster_indexes" ADD COLUMN "spec_digest" text GENERATED ALWAYS AS (encode(sha256(spec::text::bytea), 'hex')) STORED NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_indexes_identity" ON "cluster_indexes" USING btree ("cluster_id","database","collection","index_name","spec_digest");--> statement-breakpoint

-- The largest interval between two consecutive observations INSIDE a run, in ms.
-- Zero for a run of one, which has no interior, and zero for every row written
-- before this column existed — those are trusted exactly as they were.
--
-- A run asserts the counter held throughout its span, and the readers only inspect
-- the holes BETWEEN runs, which is sound precisely while the collector refuses to
-- extend across a gap the trust gate would object to. That made a safety property
-- depend on MAX_GAP_HOURS meaning the same thing in two modules forever, with
-- nothing in the data to check it against. Maintained on extend as
-- greatest(previous, now - last_seen_at), it becomes something the reader can test.
--
-- bigint rather than integer deliberately: int4 tops out near 24 days of
-- milliseconds, and a check that overflows exactly when the thing it guards against
-- happens is not a check.
ALTER TABLE "index_snapshots" ADD COLUMN "max_gap_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "latency_samples" ADD COLUMN "max_gap_ms" bigint DEFAULT 0 NOT NULL;
