-- How far along its engine's privilege changes each cluster's credentials are
-- known to be (#599). Additive with a default of 0 — before the first change — so
-- every existing cluster is told about the privileges added since it connected,
-- which on MongoDB is enableProfiler (0.29.0) and nothing else.
ALTER TABLE "clusters" ADD COLUMN "privileges_revision" integer DEFAULT 0 NOT NULL;