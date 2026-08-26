CREATE TABLE "tunnels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sealed_dek" "bytea" NOT NULL,
	"sealed_data" "bytea" NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "tunnel_id" uuid;--> statement-breakpoint
ALTER TABLE "tunnels" ADD CONSTRAINT "tunnels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tunnels_org_name_key" ON "tunnels" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "tunnels_org_idx" ON "tunnels" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_tunnel_id_tunnels_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "public"."tunnels"("id") ON DELETE restrict ON UPDATE no action;