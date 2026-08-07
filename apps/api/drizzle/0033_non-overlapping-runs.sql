ALTER TABLE "index_snapshots" ADD COLUMN "span" "tstzrange" GENERATED ALWAYS AS (tstzrange(captured_at, last_seen_at, '[]')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "latency_samples" ADD COLUMN "span" "tstzrange" GENERATED ALWAYS AS (tstzrange(captured_at, last_seen_at, '[]')) STORED NOT NULL;--> statement-breakpoint

-- Hand-written from here: drizzle has no builder for exclusion constraints.
--
-- `btree_gist` is core contrib, not a third-party extension — it ships with every
-- Postgres, including RDS and Cloud SQL, so this does not change what a deployment
-- has to install. All it adds is the equality operators GiST needs for uuid and
-- text, which is what lets one constraint mix `index_id WITH =` against
-- `span WITH &&`.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- Two runs for one index must never overlap. The writer already avoids it, and
-- "the writer already avoids it" is exactly the kind of invariant that stops being
-- true one refactor later — so the database holds it instead.
--
-- Overlap is not hypothetical. Two collects racing, or a clock stepping backwards
-- between them, can produce a row whose captured_at precedes the previous run's
-- last_seen_at. Every reader finds the holes in a series by differencing
-- `previous.last_seen_at → next.captured_at`, so an overlap there is a NEGATIVE
-- gap — which reads as no gap at all. That is the exact failure this whole change
-- was careful about, arriving by the back door: a series that looks unbroken across
-- a window nobody watched. A loud insert failure is the better outcome.
--
-- Inclusive bounds, deliberately. With '[)' a run of one observation would be an
-- EMPTY range, and an empty range overlaps nothing — so the majority of rows on a
-- busy cluster would carry no protection at all. Consecutive runs always begin
-- strictly after the previous one ended (a different observation), so inclusive
-- bounds never false-positive on legitimate data.
ALTER TABLE "index_snapshots"
  ADD CONSTRAINT "index_snapshots_no_overlap"
  EXCLUDE USING gist ("index_id" WITH =, "span" WITH &&);--> statement-breakpoint

ALTER TABLE "latency_samples"
  ADD CONSTRAINT "latency_samples_no_overlap"
  EXCLUDE USING gist ("cluster_id" WITH =, "database" WITH =, "collection" WITH =, "span" WITH &&);