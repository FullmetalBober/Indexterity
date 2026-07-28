ALTER TABLE "clusters" RENAME COLUMN "demo_mode" TO "read_only";--> statement-breakpoint
CREATE INDEX "actions_recommendation" ON "actions" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX "index_snapshots_cluster_time" ON "index_snapshots" USING btree ("cluster_id","captured_at");--> statement-breakpoint
CREATE INDEX "latency_samples_cluster_time" ON "latency_samples" USING btree ("cluster_id","captured_at");--> statement-breakpoint
CREATE INDEX "recommendations_cluster_state" ON "recommendations" USING btree ("cluster_id","state");
