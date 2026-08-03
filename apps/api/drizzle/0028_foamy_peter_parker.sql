ALTER TABLE "roi_metrics" DROP CONSTRAINT "roi_metrics_recommendation_id_recommendations_id_fk";
--> statement-breakpoint
ALTER TABLE "roi_metrics" ADD CONSTRAINT "roi_metrics_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE set null ON UPDATE no action;