-- How far each pass is paced on each cluster (#571, D179). Only `collect` uses
-- it: a collect that does not fit its budget runs every 2^tier hours with 2^tier
-- times the base budget. Additive with a default, so every existing row reads as
-- "not paced", which is what every cluster is until its next collect says so.
ALTER TABLE "cluster_pass_timings" ADD COLUMN "tier" smallint DEFAULT 0 NOT NULL;