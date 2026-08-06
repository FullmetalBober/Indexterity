ALTER TABLE "invites" DROP CONSTRAINT "invites_token_unique";--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "accepted_at";--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "is_active";--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug_unique" UNIQUE("slug");