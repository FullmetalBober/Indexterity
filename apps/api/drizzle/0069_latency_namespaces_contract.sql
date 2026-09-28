-- CONTRACT: the namespace lives on `cluster_namespaces` now (0068), so the two
-- text columns go, and so does the stored `span` (#551).
--
-- The no-overlap constraint is the one thing here the generator cannot write.
-- It is hand-written, as 0033 wrote it, and it has to come off FIRST: it is
-- built on `database`, `collection` and `span`, and postgres refuses to drop a
-- column a constraint still depends on.
ALTER TABLE "latency_samples" DROP CONSTRAINT "latency_samples_no_overlap";--> statement-breakpoint
DROP INDEX "latency_samples_cluster_ns_time";--> statement-breakpoint

-- Fill `namespace_id` and drop the three columns in ONE statement, because one
-- ALTER TABLE rewrites the table once, and a rewrite is the only thing that
-- takes a dropped column's bytes out of the rows already stored. A bare
-- DROP COLUMN marks the column gone and leaves every existing row the size it
-- was, until retention deletes it. An UPDATE to fill the column first would
-- leave a dead copy of every row behind it. drizzle runs all pending migrations
-- in one transaction, so not even a CLUSTER afterwards could discard that copy:
-- it was measured copying both, 18 MB of heap becoming 27. Here the rewrite
-- happens under a new file, and the old file goes when the migration commits.
--
-- The USING expression is evaluated against each OLD row, so it can still read
-- `database` and `collection` while the same statement drops them. It cannot
-- hold a subquery, hence the lookup function, which is session-local (pg_temp)
-- and gone when the migration's connection closes. 0068 inserted a namespace
-- for every (cluster, database, collection) the table holds, so the lookup
-- always finds one, and SET NOT NULL is what would say otherwise.
CREATE FUNCTION pg_temp.namespace_of(uuid, text, text) RETURNS integer
  LANGUAGE sql STABLE
  AS $$ select id from public.cluster_namespaces where cluster_id = $1 and database = $2 and collection = $3 $$;--> statement-breakpoint
ALTER TABLE "latency_samples"
  ALTER COLUMN "namespace_id" TYPE integer USING pg_temp.namespace_of("cluster_id", "database", "collection"),
  ALTER COLUMN "namespace_id" SET NOT NULL,
  DROP COLUMN "database",
  DROP COLUMN "collection",
  DROP COLUMN "span";--> statement-breakpoint

-- The same guard as 0033's, and it needs neither of the things it used to.
--
-- Keyed on the namespace id where it was keyed on (cluster_id, database,
-- collection), which is the same identity, since a namespace row belongs to one
-- cluster. And over the range EXPRESSION rather than a stored copy of it. An
-- exclusion constraint takes expressions the way an index does, so the stored
-- column existed only to be indexed, and it cost the row both bounds a second
-- time. Inclusive bounds for 0033's reason: with '[)' a run of one observation is
-- an empty range, and an empty range overlaps nothing. `btree_gist`, which 0033
-- installed, supplies the integer equality.
ALTER TABLE "latency_samples"
  ADD CONSTRAINT "latency_samples_no_overlap"
  EXCLUDE USING gist ("namespace_id" WITH =, tstzrange("captured_at", "last_seen_at", '[]') WITH &&);
