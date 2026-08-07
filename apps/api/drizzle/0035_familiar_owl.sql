ALTER TABLE "invites" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "logo" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "metadata" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "active_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_active_organization_id_organizations_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Backfill, between the expand above and the contract in the next migration.
--
-- Slugs. Every org created before this migration was named "My Org" by the lazy
-- creation this change removes, so the interesting case is not "slugify a name",
-- it is "slugify the same name a hundred times". The oldest org in each name
-- group keeps the clean slug and the rest take an id suffix.
UPDATE "organizations" AS o
SET "slug" = s."slug"
FROM (
  SELECT
    "id",
    CASE WHEN "rn" = 1 THEN "base" ELSE "base" || '-' || left(replace("id"::text, '-', ''), 8) END AS "slug"
  FROM (
    SELECT
      "id",
      coalesce(nullif(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''), 'org') AS "base",
      row_number() OVER (
        PARTITION BY coalesce(nullif(trim(both '-' from regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''), 'org')
        ORDER BY "created_at", "id"
      ) AS "rn"
    FROM "organizations"
  ) AS derived
) AS s
WHERE o."id" = s."id";--> statement-breakpoint

-- The suffix above is eight hex characters, so an org genuinely named
-- "My Org 3f2a1b9c" could still collide with the second "My Org". Rare enough to
-- be worth one more pass rather than a wider suffix on every row: anything still
-- doubled takes its whole id, which cannot collide. The unique index added in
-- the contract migration is the proof.
UPDATE "organizations" AS o
SET "slug" = o."slug" || '-' || replace(o."id"::text, '-', '')
WHERE EXISTS (
  SELECT 1 FROM "organizations" AS x WHERE x."slug" = o."slug" AND x."id" <> o."id"
);--> statement-breakpoint

-- Invite state stops being a nullable date. An expired invite stays `pending` —
-- the plugin reads `expires_at` itself, and "we cancelled it" would be a claim
-- nobody made.
UPDATE "invites" SET "status" = 'accepted' WHERE "accepted_at" IS NOT NULL;--> statement-breakpoint

-- The org switcher's selection moves from the user to the session. Every live
-- session of a user who had switched inherits that choice, so nobody is silently
-- moved to another org by deploying this.
UPDATE "session" AS s
SET "active_organization_id" = m."org_id"
FROM "members" AS m
WHERE m."user_id" = s."user_id" AND m."is_active" = true;
