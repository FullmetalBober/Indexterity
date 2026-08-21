CREATE TYPE "public"."credential_posture" AS ENUM('PROVISIONED', 'ADMIN', 'SCOPED');--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "credential_posture" "credential_posture";