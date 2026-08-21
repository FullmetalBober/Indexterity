CREATE TABLE "org_policies" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"require_least_privilege" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_policies" ADD CONSTRAINT "org_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;