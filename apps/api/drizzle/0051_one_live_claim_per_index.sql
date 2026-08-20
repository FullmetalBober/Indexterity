-- Duplicates that already exist would refuse the index below, and a deploy that
-- dies on `could not create unique index` leaves an operator with a raw pg error
-- and no way to read what it means. Measured before writing this, at the claim
-- granularity the index actually keys on rather than per type: 52 live BUILD
-- rows, 14 live DROP, zero collisions in either. So on this deployment the
-- statement is a no-op, and it is here for the ones nobody has looked at.
--
-- The distinction matters. Counting per TYPE says nothing about this index: a
-- live CREATE and a live UPDATE on one index name are two rows of different
-- types and ONE claim, so a per-type tally can read clean while the index would
-- still refuse. Re-run the grouped count above against production before
-- shipping, not the per-type one.
--
-- The oldest row in each collision keeps its claim, the same rule #96 used for
-- duplicate cluster names. It is also the right one on the merits: a row that
-- has advanced past PROPOSED was PROPOSED first, so age already favours the one
-- the customer has acted on. A losing PROPOSED row costs nothing at all —
-- classify and suggest rewrite theirs from scratch on every pass, so the finding
-- comes straight back if it is still true.
--
-- `actions` cascades, so the audit rows of a deleted duplicate go with it. That
-- is the trade being made deliberately: the alternative is two live rows racing
-- to drop or build the same index, which is the state this index exists to make
-- unrepresentable.
DELETE FROM "recommendations" AS r
USING (
	SELECT "id",
		row_number() OVER (
			PARTITION BY "cluster_id", "database", "collection", "index_name",
				(CASE WHEN "type" IN ('DROP_UNUSED', 'DROP_REDUNDANT') THEN 'DROP' ELSE 'BUILD' END)
			ORDER BY "created_at", "id"
		) AS rank
	FROM "recommendations"
	WHERE "state" IN ('PROPOSED', 'APPROVED', 'HIDDEN', 'OBSERVE', 'SCHEDULED', 'BUILDING')
		AND "type" <> 'ADVISORY_REVIEW'
) AS ranked
WHERE ranked."id" = r."id" AND ranked.rank > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_one_live_claim" ON "recommendations" USING btree ("cluster_id","database","collection","index_name",(case when "type" in ('DROP_UNUSED', 'DROP_REDUNDANT') then 'DROP' else 'BUILD' end)) WHERE "state" in ('PROPOSED', 'APPROVED', 'HIDDEN', 'OBSERVE', 'SCHEDULED', 'BUILDING') and "type" <> 'ADVISORY_REVIEW';
