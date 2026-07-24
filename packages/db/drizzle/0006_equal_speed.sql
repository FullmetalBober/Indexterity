ALTER TABLE "clusters" DROP CONSTRAINT "clusters_agent_token_unique";--> statement-breakpoint
ALTER TABLE "clusters" ALTER COLUMN "sealed_dek" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clusters" ALTER COLUMN "sealed_data" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clusters" DROP COLUMN "agent_token";