import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { cluster, recommendation } from "./schemas";

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
  approveRecommendation: {
    method: "POST",
    path: "/recommendations/:id/approve",
    pathParams: z.object({ id: z.string().uuid() }),
    body: z.object({}),
    responses: { 200: recommendation, 404: z.object({ message: z.string() }) },
    summary: "Approve a recommendation, moving it into the apply pipeline",
  },
});
