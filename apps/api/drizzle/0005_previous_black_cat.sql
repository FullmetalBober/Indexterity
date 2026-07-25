ALTER TABLE "clusters" ALTER COLUMN "sealed_dek" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "clusters" ALTER COLUMN "sealed_data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "agent_token" text;--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_agent_token_unique" UNIQUE("agent_token");