import { hashKey, partialMatchKey, QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "./keys";
import {
  type ClusterIndexPage,
  clusterIndexesQuery,
  clusterWorkloadQuery,
  NO_CLUSTER_INDEXES,
  NO_CLUSTER_WORKLOAD,
  type WorkloadPage,
} from "./telemetry";

const getClusterIndexes = vi.hoisted(() => vi.fn());
const getClusterWorkload = vi.hoisted(() => vi.fn());

// The real client with these calls replaced, through a forwarding Proxy: the
// oRPC client is itself a Proxy over fetch, so spreading it yields `{}` and a
// call this test never set up would answer `undefined` instead of failing.
vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>();
  const { overriding } = await import("~/lib/overriding");
  return {
    ...actual,
    api: () => overriding(actual.api(), { getClusterIndexes, getClusterWorkload }),
  };
});

const CLUSTER = "c1";
const FIRST: ClusterIndexPage = { offset: 0, limit: 100, sort: "namespace", dir: "asc" };

beforeEach(() => {
  getClusterIndexes.mockReset();
  getClusterWorkload.mockReset();
});

// The defect (#455): every page, size, order and search of one cluster hashed to
// ONE entry, so a click stored the new request and rendered the cached first
// page. Asserted on the hash, because the hash is what TanStack Query compares —
// two keys that differ as arrays but hash alike are one entry.
describe("the inventory's key", () => {
  it.each<[string, ClusterIndexPage]>([
    ["the next page", { ...FIRST, offset: 100 }],
    ["a smaller page", { ...FIRST, limit: 25 }],
    ["another order", { ...FIRST, sort: "sizeBytes", dir: "desc" }],
    ["a search", { ...FIRST, q: "zip" }],
    ["a namespace scope", { ...FIRST, database: "shop", collection: "orders" }],
  ])("gives %s an entry of its own", (_, page) => {
    expect(hashKey(clusterIndexesQuery(CLUSTER, page).queryKey)).not.toBe(
      hashKey(clusterIndexesQuery(CLUSTER, FIRST).queryKey),
    );
  });

  // Canonical however the caller built it: member order does not matter, and an
  // undefined member is the same as an absent one — which is what lets the query
  // function spread the page whole instead of forwarding members by name.
  it("hashes the same request the same, whatever order it was written in", () => {
    const rebuilt: ClusterIndexPage = {
      dir: "asc",
      limit: 100,
      q: undefined,
      sort: "namespace",
      offset: 0,
    };
    expect(hashKey(clusterIndexesQuery(CLUSTER, rebuilt).queryKey)).toBe(
      hashKey(clusterIndexesQuery(CLUSTER, FIRST).queryKey),
    );
  });

  // The invalidations name the prefix, not a page: a collect moves every page.
  it("keeps every page under the prefix the invalidations use", () => {
    for (const page of [FIRST, { ...FIRST, offset: 100, q: "zip" }]) {
      const key = clusterIndexesQuery(CLUSTER, page).queryKey;
      expect(partialMatchKey(key, queryKeys.clusterIndexesAll(CLUSTER))).toBe(true);
      expect(partialMatchKey(key, queryKeys.clusterIndexesAll("c2"))).toBe(false);
    }
  });
});

describe("the workload's key", () => {
  const first: WorkloadPage = { offset: 0, limit: 50, sort: "weeklyDocsExamined", dir: "desc" };

  it.each<[string, WorkloadPage]>([
    ["the next page", { ...first, offset: 50 }],
    ["another order", { ...first, sort: "namespace", dir: "asc" }],
    ["a search", { ...first, q: "orders" }],
    ["the declined shapes only", { ...first, declinedOnly: true }],
  ])("gives %s an entry of its own", (_, page) => {
    expect(hashKey(clusterWorkloadQuery(CLUSTER, page).queryKey)).not.toBe(
      hashKey(clusterWorkloadQuery(CLUSTER, first).queryKey),
    );
  });

  it("keeps every page under the prefix the invalidations use", () => {
    const key = clusterWorkloadQuery(CLUSTER, { ...first, offset: 50 }).queryKey;
    expect(partialMatchKey(key, queryKeys.clusterWorkloadAll(CLUSTER))).toBe(true);
  });
});

// What reaches the api: the page, whole. The forwarder this replaces named four
// members and so sent four, and `sort`, `dir` and `q` never left the browser.
describe("what the paged reads ask the api", () => {
  it("asks for the whole inventory page it was given", async () => {
    getClusterIndexes.mockResolvedValue(NO_CLUSTER_INDEXES);
    const page: ClusterIndexPage = {
      database: "shop",
      collection: "orders",
      offset: 100,
      limit: 25,
      sort: "sizeBytes",
      dir: "desc",
      q: "zip",
    };
    await new QueryClient().fetchQuery(clusterIndexesQuery(CLUSTER, page));
    expect(getClusterIndexes).toHaveBeenCalledWith({ clusterId: CLUSTER, ...page });
  });

  it("asks for the whole workload page it was given", async () => {
    getClusterWorkload.mockResolvedValue(NO_CLUSTER_WORKLOAD);
    const page: WorkloadPage = {
      declinedOnly: true,
      offset: 50,
      limit: 10,
      sort: "executions",
      dir: "asc",
      q: "orders",
    };
    await new QueryClient().fetchQuery(clusterWorkloadQuery(CLUSTER, page));
    expect(getClusterWorkload).toHaveBeenCalledWith({ clusterId: CLUSTER, ...page });
  });

  // Null means there is no cluster to ask about, not "whichever is first".
  it("asks nothing for no cluster", async () => {
    const answer = await new QueryClient().fetchQuery(clusterIndexesQuery(null, FIRST));
    expect(answer).toBe(NO_CLUSTER_INDEXES);
    expect(getClusterIndexes).not.toHaveBeenCalled();
  });
});
