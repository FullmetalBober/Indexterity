-- What a failure watch's passes remember (#641, #642): each namespace's start,
-- when each node was last seen watching, and the stretches nodes missed, so a
-- watch a restart cleared is put back as it was rather than started over; and
-- how far back each database's profiler rings reach, for the dashboard. Existing
-- rows start empty and not watching, and the next hourly pass fills them.
ALTER TABLE "failure_watches" ADD COLUMN "starts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "failure_watches" ADD COLUMN "confirmed" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "failure_watches" ADD COLUMN "gaps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "failure_watches" ADD COLUMN "watching" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "failure_watches" ADD COLUMN "ring_reach_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "failure_watches" ADD COLUMN "ring_checked_at" timestamp with time zone;