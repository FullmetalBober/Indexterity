ALTER TABLE "organizations" ADD COLUMN "plan" text DEFAULT 'FREE' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan_note" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_provider" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_customer_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "billing_subscription_id" text;