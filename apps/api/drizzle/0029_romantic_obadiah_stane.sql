CREATE INDEX "account_user" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "clusters_org" ON "clusters" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "invites_org" ON "invites" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "invites_invited_by" ON "invites" USING btree ("invited_by");--> statement-breakpoint
CREATE INDEX "members_user_org" ON "members" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "members_org" ON "members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "roi_metrics_recommendation" ON "roi_metrics" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX "roi_metrics_cluster" ON "roi_metrics" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "session_user" ON "session" USING btree ("user_id");