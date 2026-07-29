import { initContract } from "@ts-rest/core";
import { z } from "zod";
import {
  auditAction,
  cluster,
  clusterLatency,
  clusterLatencySeries,
  clusterPolicy,
  clusterRoi,
  createdInvite,
  orgInfo,
  recommendation,
} from "./schemas.js";

const c = initContract();

// Typed contract shared by api (server) and web (client). One source of truth.
export const contract = c.router({
  listClusters: {
    method: "GET",
    path: "/clusters",
    responses: { 200: z.array(cluster) },
    summary: "List connected clusters",
  },
  listRecommendations: {
    method: "GET",
    path: "/clusters/:clusterId/recommendations",
    pathParams: z.object({ clusterId: z.string().uuid() }),
    responses: { 200: z.array(recommendation) },
    summary: "List recommendations for a cluster",
  },
  getRoi: {
    method: "GET",
    path: "/clusters/:clusterId/roi",
    pathParams: z.object({ clusterId: z.string().uuid() }),
    responses: { 200: clusterRoi },
    summary: "Realized ROI for a cluster (freed bytes, indexes dropped)",
  },
  getLatency: {
    method: "GET",
    path: "/clusters/:clusterId/latency",
    pathParams: z.object({ clusterId: z.string().uuid() }),
    responses: { 200: clusterLatency },
    summary: "Per-collection read/write latency trend (before/after)",
  },
  getLatencySeries: {
    method: "GET",
    path: "/clusters/:clusterId/latency-series",
    pathParams: z.object({ clusterId: z.string().uuid() }),
    responses: { 200: clusterLatencySeries },
    summary: "Per-collection windowed latency time series (µs per op)",
  },
  createCluster: {
    method: "POST",
    path: "/clusters",
    body: z.object({ name: z.string().min(1), connectionString: z.string().min(1) }),
    responses: { 200: cluster, 400: z.object({ message: z.string() }) },
    summary: "Connect a cluster; stores its connection string envelope-encrypted",
  },
  setClusterMode: {
    method: "PATCH",
    path: "/clusters/:clusterId/mode",
    pathParams: z.object({ clusterId: z.string().uuid() }),
    body: z.object({ readOnly: z.boolean() }),
    responses: { 200: cluster, 404: z.object({ message: z.string() }) },
    summary: "Toggle read-only mode (owner only) — live mode lets the engine write",
  },
  listActions: {
    method: "GET",
    path: "/clusters/:clusterId/actions",
    pathParams: z.object({ clusterId: z.string().uuid() }),
    responses: { 200: z.array(auditAction) },
    summary: "The cluster's audit trail (latest 50 executed operations)",
  },
  getPolicy: {
    method: "GET",
    path: "/clusters/:clusterId/policy",
    pathParams: z.object({ clusterId: z.string().uuid() }),
    responses: { 200: clusterPolicy, 404: z.object({ message: z.string() }) },
    summary: "The cluster's engine knobs (defaults when never configured)",
  },
  updatePolicy: {
    method: "PUT",
    path: "/clusters/:clusterId/policy",
    pathParams: z.object({ clusterId: z.string().uuid() }),
    body: clusterPolicy.omit({ clusterId: true }),
    responses: { 200: clusterPolicy, 404: z.object({ message: z.string() }) },
    summary: "Replace the cluster's engine knobs (owner only)",
  },
  triggerCollect: {
    method: "POST",
    path: "/clusters/:clusterId/collect",
    pathParams: z.object({ clusterId: z.string().uuid() }),
    body: z.object({}),
    responses: {
      200: z.object({ snapshots: z.number().int(), recommendations: z.number().int() }),
      404: z.object({ message: z.string() }),
    },
    summary: "Collect + classify a cluster now",
  },
  approveRecommendation: {
    method: "POST",
    path: "/recommendations/:id/approve",
    pathParams: z.object({ id: z.string().uuid() }),
    body: z.object({}),
    responses: { 200: recommendation, 404: z.object({ message: z.string() }) },
    summary: "Approve a recommendation, moving it into the apply pipeline",
  },
  rollbackRecommendation: {
    method: "POST",
    path: "/recommendations/:id/rollback",
    pathParams: z.object({ id: z.string().uuid() }),
    body: z.object({}),
    responses: {
      200: recommendation,
      404: z.object({ message: z.string() }),
      409: z.object({ message: z.string() }),
    },
    summary: "Undo a drop: rebuild the index from its rollback token",
  },
  getOrg: {
    method: "GET",
    path: "/org",
    responses: { 200: orgInfo },
    summary: "The caller's org: members and pending invites",
  },
  createInvite: {
    method: "POST",
    path: "/org/invites",
    body: z.object({ email: z.string().email(), role: z.enum(["member", "owner"]) }),
    responses: { 200: createdInvite },
    summary: "Invite someone into the org; returns the one-time token",
  },
  acceptInvite: {
    method: "POST",
    path: "/invites/accept",
    body: z.object({ token: z.string().min(1) }),
    responses: {
      200: z.object({ orgId: z.string().uuid(), orgName: z.string() }),
      404: z.object({ message: z.string() }),
      409: z.object({ message: z.string() }),
    },
    summary: "Join an org with an invite token",
  },
});
