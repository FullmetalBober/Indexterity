import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { cluster, clusterLatency, clusterRoi, recommendation } from "./schemas.js";

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
  createCluster: {
    method: "POST",
    path: "/clusters",
    body: z.object({ name: z.string().min(1), connectionString: z.string().min(1) }),
    responses: { 200: cluster },
    summary: "Connect a cluster; stores its connection string envelope-encrypted",
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
});
