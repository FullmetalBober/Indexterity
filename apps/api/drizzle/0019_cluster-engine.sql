CREATE TYPE "public"."cluster_engine" AS ENUM('MONGODB', 'POSTGRESQL', 'MSSQL');--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "engine" "cluster_engine" DEFAULT 'MONGODB' NOT NULL;