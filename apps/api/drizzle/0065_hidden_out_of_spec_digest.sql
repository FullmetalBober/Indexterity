-- `hidden` leaves the index identity (#496).
--
-- It is a state flag, not a shape: an index does not become a different index
-- when it is hidden, which is the whole premise of hide-then-observe. Leaving it
-- in the digest meant this product split an index's history in half every time it
-- acted on one — 28 duplicate identities on the hosted deployment, 26 of them
-- differing in nothing else.
--
-- Those 26 pairs have to become one row BEFORE the digest stops separating them,
-- or `cluster_indexes_identity` cannot be recreated. Merging is three steps, and
-- the middle one is the reason this is not a one-line ALTER.

-- Who merges into whom. The survivor is the NEWEST row of each group, so the
-- spec that is kept is the index's current one. `rank` orders the rest behind it.
CREATE TEMPORARY TABLE hidden_digest_merge ON COMMIT DROP AS
  SELECT
    id,
    first_value(id) OVER w AS survivor,
    row_number() OVER w AS rank
  FROM "cluster_indexes"
  WINDOW w AS (
    PARTITION BY
      "cluster_id", "database", "collection", "index_name",
      encode(sha256(("spec" - 'hidden')::text::bytea), 'hex')
    ORDER BY "created_at" DESC, "id"
  );--> statement-breakpoint

-- `index_snapshots` carries EXCLUDE USING gist (index_id WITH =, span WITH &&):
-- two runs for one index may never overlap. Repointing without this would fail
-- the constraint on any pair of runs that do, and a migration that can fail on a
-- customer's data is not one.
--
-- Overlap between the two halves should not arise — a run for the old spec ends
-- when the spec changes and the new one starts after — but "should not" is not a
-- thing to bet a migration on. Where two runs do overlap, the one covering LESS
-- time goes: the survivors are then the widest evidence available, and what is
-- dropped is coverage the keeper already asserts. Length first, then the merge
-- rank, then the id, so the order is total and the outcome does not depend on
-- which row the planner reached first.
--
-- A row survives only if nothing preferred to it overlaps it, so no two
-- survivors can overlap: of any overlapping pair, one is preferred and the other
-- would have gone.
DELETE FROM "index_snapshots" victim
USING "index_snapshots" keeper, hidden_digest_merge mv, hidden_digest_merge mk
WHERE victim."index_id" = mv.id
  AND keeper."index_id" = mk.id
  AND mv.survivor = mk.survivor
  AND victim."id" <> keeper."id"
  AND victim."span" && keeper."span"
  AND (
        -extract(epoch from (upper(keeper."span") - lower(keeper."span"))),
        mk.rank,
        keeper."id"
      ) < (
        -extract(epoch from (upper(victim."span") - lower(victim."span"))),
        mv.rank,
        victim."id"
      );--> statement-breakpoint

UPDATE "index_snapshots" s
SET "index_id" = m.survivor
FROM hidden_digest_merge m
WHERE s."index_id" = m.id AND m.id <> m.survivor;--> statement-breakpoint

DELETE FROM "cluster_indexes" c
USING hidden_digest_merge m
WHERE c."id" = m.id AND m.id <> m.survivor;--> statement-breakpoint

-- Dropping the column drops `cluster_indexes_identity` with it, so the index is
-- recreated below. Drizzle's own diff does not know that and would have left the
-- table without its identity constraint.
ALTER TABLE "cluster_indexes" drop column "spec_digest";--> statement-breakpoint
ALTER TABLE "cluster_indexes" ADD COLUMN "spec_digest" text GENERATED ALWAYS AS (encode(sha256((spec - 'hidden')::text::bytea), 'hex')) STORED NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_indexes_identity" ON "cluster_indexes" USING btree ("cluster_id","database","collection","index_name","spec_digest");
