ALTER TABLE "members" ADD COLUMN "is_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "roi_metrics" ADD COLUMN "recommendation_id" uuid;--> statement-breakpoint
ALTER TABLE "roi_metrics" ADD CONSTRAINT "roi_metrics_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE cascade ON UPDATE no action;