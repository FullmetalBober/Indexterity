-- Duplicates that already exist would refuse the constraint below, and until it
-- lands nobody can rename their way out of one: the name is set at connect time
-- and the only escape is a disconnect, which deletes every measurement,
-- recommendation and action the cluster ever had (#96).
--
-- So they are separated here rather than left for an operator to find in a failed
-- deploy. The oldest row in each collision keeps the name it has; every later one
-- gets its own id's first eight characters appended — unique by construction, and
-- legible enough that whoever finds it can see it was a machine and which row it
-- names. Renaming it to something better is now one field on the settings page.
UPDATE "clusters" AS c
SET "name" = c."name" || ' (' || left(c."id"::text, 8) || ')'
WHERE EXISTS (
	SELECT 1
	FROM "clusters" AS earlier
	WHERE earlier."org_id" = c."org_id"
		AND earlier."name" = c."name"
		AND (earlier."created_at", earlier."id") < (c."created_at", c."id")
);--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_org_name" UNIQUE("org_id","name");
