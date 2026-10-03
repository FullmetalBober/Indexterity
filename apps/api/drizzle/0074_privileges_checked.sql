-- How far along its engine's privilege changes each cluster's credentials have
-- been checked (#599). Additive with a default of 0, so every existing cluster's
-- changes start unknown, not missing: nothing is shown until a collect has asked
-- the cluster what its credentials hold and found a privilege absent.
ALTER TABLE "clusters" ADD COLUMN "privileges_checked_revision" integer DEFAULT 0 NOT NULL;