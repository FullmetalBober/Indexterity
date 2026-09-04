import type {
  Cluster,
  ClusterIndexes,
  ClusterIndexRow,
  ClusterWorkload,
  WorkloadShape,
} from "@repo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterIndexesPage } from "~/components/app/indexes-page";
import { TooltipProvider } from "~/components/ui/tooltip";
import { renderInApp, runLoader } from "~/test-utils";
import { Route } from "./app.clusters.$clusterId.indexes";

// The seam nothing had tested (#455). The table test mocks `onChange`, the api's
// test calls `?offset=` directly, and e2e never opens this tab — so for three
// releases a click on page two stored the new request, rendered the cached page
// one, and every suite was green. These render the page against a fake api and
// read what the api was ASKED.

const getClusterIndexes = vi.hoisted(() => vi.fn());
const getClusterWorkload = vi.hoisted(() => vi.fn());
const getNodes = vi.hoisted(() => vi.fn());
const listClusters = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>();
  const { overriding } = await import("~/lib/overriding");
  return {
    ...actual,
    api: () =>
      overriding(actual.api(), { getClusterIndexes, getClusterWorkload, getNodes, listClusters }),
  };
});

// A Link outside a router throws, and the Proposed column draws one — the
// anchor stands in, as index-table.test.tsx does. `createFileRoute` and the rest
// of the module stay real.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { anchorLink, overriding } = await import("~/lib/overriding");
  return overriding(actual, { Link: anchorLink });
});

const CLUSTER = "11111111-1111-4111-8111-111111111111";
const INDEXES = 522;
const SHAPES = 312;

const cluster: Cluster = {
  id: CLUSTER,
  name: "Production",
  connectionMode: "HOSTED_DIRECT",
  engine: "MSSQL",
  readOnly: true,
  tunnelId: null,
  provisionedUsername: null,
  revokeCommand: null,
  credentialPosture: null,
  lastCollectedAt: "2026-09-04T09:14:44.000Z",
  blocked: null,
  tlsOverrides: { allowInvalidCertificates: false, allowInvalidHostnames: false, insecure: false },
  observedDatabases: null,
  createdAt: "2026-08-01T00:00:00.000Z",
};

// Rows named by their position in the whole set, so a page that arrived is
// distinguishable from the page before it by reading the table.
function indexRow(position: number): ClusterIndexRow {
  return {
    id: `index-${position}`,
    database: "BaseData",
    collection: "dbo.Orders",
    indexName: `idx_${position}`,
    keys: [{ field: "status", direction: 1 }],
    include: [],
    unique: false,
    ttl: false,
    partial: false,
    partialFilter: null,
    sparse: false,
    hidden: false,
    isShardKey: false,
    collation: null,
    hinted: false,
    sizeBytes: 4096 * position,
    totalOps: 0,
    perMember: [],
    observedAt: "2026-09-04T09:14:44.000Z",
    recommendation: null,
  };
}

// The api ECHOES the offset it served (D133), and the control draws the served
// page. A fake that always answered offset 0 would hide exactly the defect: the
// click landing, and the page snapping back.
function inventoryPage(input: {
  offset?: number | undefined;
  limit?: number | undefined;
}): ClusterIndexes {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 100;
  return {
    clusterId: CLUSTER,
    indexes: [indexRow(offset + 1), indexRow(offset + 2)],
    total: INDEXES,
    offset,
    limit,
    collectedAt: "2026-09-04T09:14:44.000Z",
  };
}

function shape(position: number): WorkloadShape {
  return {
    id: `shape-${position}`,
    database: "BaseData",
    collection: `dbo.Table${position}`,
    keys: { equality: ["status"], sort: [], range: [] },
    collscan: true,
    sortedInMemory: false,
    executions: 1200,
    docsExamined: 900_000,
    observedForHours: 168,
    weeklyDocsExamined: 900_000,
    severity: "ROUTINE",
    clients: [],
    outcome: "below-cost-floor",
    outcomeRaw: "below-cost-floor",
    explanation: "Costs less than a million documents a week.",
    proposedIndex: null,
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-04T00:00:00.000Z",
    observations: 72,
  };
}

function workloadPage(input: {
  offset?: number | undefined;
  limit?: number | undefined;
}): ClusterWorkload {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 50;
  return {
    clusterId: CLUSTER,
    shapes: [shape(offset + 1), shape(offset + 2)],
    total: SHAPES,
    offset,
    limit,
    workloadAnalysisEnabled: true,
    collectionsBelowDocFloor: 0,
    collectionsAboveSizeCeiling: 0,
    analysedAt: "2026-09-04T09:00:00.000Z",
  };
}

beforeEach(() => {
  getClusterIndexes.mockReset();
  getClusterWorkload.mockReset();
  getNodes.mockReset();
  listClusters.mockReset();
  getClusterIndexes.mockImplementation(
    async (input: { offset?: number | undefined; limit?: number | undefined }) =>
      inventoryPage(input),
  );
  getClusterWorkload.mockImplementation(
    async (input: { offset?: number | undefined; limit?: number | undefined }) =>
      workloadPage(input),
  );
  getNodes.mockResolvedValue({ clusterId: CLUSTER, collectedAt: null, nodes: [] });
  listClusters.mockResolvedValue([cluster]);
});

// The two footers share button names ("Page 2" is in both), so every control is
// found inside its own table's navigation.
function inventoryNav() {
  return within(screen.getByRole("navigation", { name: "indexes pagination" }));
}

function workloadNav() {
  return within(screen.getByRole("navigation", { name: "query shapes pagination" }));
}

async function renderPage() {
  const rendered = renderInApp(<ClusterIndexesPage clusterId={CLUSTER} />);
  await screen.findByText("idx_1");
  await screen.findByText("BaseData.dbo.Table1");
  return rendered;
}

// The app's own client settings where they decide the outcome (queries/client.ts):
// thirty seconds of freshness is what makes a page already seen a cache hit, and
// a loader's warm-up count as fresh on mount. renderInApp's client has neither,
// so the two tests about the cache render through this instead.
function appClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
}

async function renderPageOn(queryClient: QueryClient) {
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <ClusterIndexesPage clusterId={CLUSTER} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("idx_1");
  await screen.findByText("BaseData.dbo.Table1");
}

// A request the test answers by hand, for the state between the click and the
// answer.
function held<T>() {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("the Indexes page, paging", () => {
  // The report: six page buttons, and clicking 2 snapped back to 1.
  it("asks for the page that was clicked, and draws it", async () => {
    await renderPage();
    expect(screen.getByText(/1-100 of 522 indexes/)).toBeInTheDocument();

    await userEvent.click(inventoryNav().getByRole("button", { name: "Page 2" }));

    await screen.findByText("idx_101");
    expect(getClusterIndexes).toHaveBeenLastCalledWith({
      clusterId: CLUSTER,
      offset: 100,
      limit: 100,
      sort: "namespace",
      dir: "asc",
    });
    expect(screen.getByText(/101-200 of 522 indexes/)).toBeInTheDocument();
    expect(inventoryNav().getByRole("button", { name: "Page 2" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("asks for the next page from the chevron", async () => {
    await renderPage();
    await userEvent.click(inventoryNav().getByRole("button", { name: "Next page" }));
    await screen.findByText("idx_101");
    expect(getClusterIndexes).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 100, limit: 100 }),
    );
  });

  it("asks for the page size that was chosen", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("combobox", { name: "indexes per page" }));
    await userEvent.click(screen.getByRole("option", { name: "25 / page" }));

    await screen.findByText(/1-25 of 522 indexes/);
    expect(getClusterIndexes).toHaveBeenLastCalledWith({
      clusterId: CLUSTER,
      offset: 0,
      limit: 25,
      sort: "namespace",
      dir: "asc",
    });
  });

  // Stepping back is a cache hit: the first page is still in the cache under its
  // own key, so the api is not asked for it twice.
  it("serves a page already seen from the cache", async () => {
    await renderPageOn(appClient());
    await userEvent.click(inventoryNav().getByRole("button", { name: "Page 2" }));
    await screen.findByText("idx_101");
    expect(getClusterIndexes).toHaveBeenCalledTimes(2);

    await userEvent.click(inventoryNav().getByRole("button", { name: "Page 1" }));
    await screen.findByText("idx_1");
    expect(getClusterIndexes).toHaveBeenCalledTimes(2);
  });

  // Between the click and the answer: the page asked for is lit, the rows in hand
  // stay (dimmed, and the table says it is busy), and the search box is still a
  // search box. Drawing the served page here would be the reported bug for the
  // length of the request; outlining the table would disable the box mid-word.
  it("lights the page asked for, and keeps the last one on screen, until it answers", async () => {
    await renderPage();
    const second = held<ClusterIndexes>();
    getClusterIndexes.mockReturnValueOnce(second.promise);

    await userEvent.click(inventoryNav().getByRole("button", { name: "Page 2" }));

    expect(inventoryNav().getByRole("button", { name: "Page 2" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("idx_1")).toBeInTheDocument();
    expect(screen.getByLabelText("Search namespace or index name")).toBeEnabled();
    const table = screen.getByRole("table", { name: /Every index this cluster has/ });
    expect(table.closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");

    second.release(inventoryPage({ offset: 100 }));
    await screen.findByText("idx_101");
    expect(table.closest("[aria-busy]")).toBeNull();
  });
});

describe("the Indexes page, order and filter", () => {
  // The arrow flipped and the rows did not move: the sort never left the browser.
  it("asks for the order a header click chose, from the first page", async () => {
    await renderPage();
    await userEvent.click(inventoryNav().getByRole("button", { name: "Page 2" }));
    await screen.findByText("idx_101");

    await userEvent.click(screen.getByRole("button", { name: /^Size/ }));

    await waitFor(() =>
      expect(getClusterIndexes).toHaveBeenLastCalledWith({
        clusterId: CLUSTER,
        offset: 0,
        limit: 100,
        sort: "sizeBytes",
        dir: "desc",
      }),
    );
  });

  it("asks for what was typed in the search box, from the first page", async () => {
    await renderPage();
    await userEvent.click(inventoryNav().getByRole("button", { name: "Page 2" }));
    await screen.findByText("idx_101");

    // Three keystrokes, three requests, and the box has to stay usable between
    // them — the first version of this fix disabled it after the first letter.
    const box = screen.getByLabelText("Search namespace or index name");
    await userEvent.type(box, "zip");

    await waitFor(() =>
      expect(getClusterIndexes).toHaveBeenLastCalledWith({
        clusterId: CLUSTER,
        offset: 0,
        limit: 100,
        sort: "namespace",
        dir: "asc",
        q: "zip",
      }),
    );
    expect(box).toBeEnabled();
    expect(box).toHaveValue("zip");
  });
});

describe("the workload table", () => {
  it("pages on its own, worst first", async () => {
    await renderPage();
    await userEvent.click(workloadNav().getByRole("button", { name: "Page 2" }));

    await screen.findByText("BaseData.dbo.Table51");
    expect(getClusterWorkload).toHaveBeenLastCalledWith({
      clusterId: CLUSTER,
      offset: 50,
      limit: 50,
      sort: "weeklyDocsExamined",
      dir: "desc",
    });
    // And the inventory was not asked again for it.
    expect(getClusterIndexes).toHaveBeenCalledTimes(1);
  });

  it("asks for the declined shapes only, from the first page", async () => {
    await renderPage();
    await userEvent.click(workloadNav().getByRole("button", { name: "Page 2" }));
    await screen.findByText("BaseData.dbo.Table51");

    await userEvent.click(screen.getByRole("checkbox", { name: /Only the ones nothing/ }));

    await waitFor(() =>
      expect(getClusterWorkload).toHaveBeenLastCalledWith({
        clusterId: CLUSTER,
        offset: 0,
        limit: 50,
        sort: "weeklyDocsExamined",
        dir: "desc",
        declinedOnly: true,
      }),
    );
  });
});

describe("the route's loader", () => {
  // The loader warmed `{}` and the component read the first page in full. Under
  // the old key they collided, which is the only reason the SSR warm-up ever
  // landed; under an honest key they have to be built from the same request, or
  // the loader fills an entry nobody reads and the tab is a skeleton on every
  // SSR. Pinned by running the REGISTERED loader and then mounting the page on
  // the same client: one request per read, not two.
  it("warms the entries the page reads", async () => {
    const queryClient = appClient();
    await runLoader(Route, { params: { clusterId: CLUSTER }, context: { queryClient } });
    // The browser branch does not await its warm-up, so wait for it to land.
    await waitFor(() => expect(getClusterIndexes).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getClusterWorkload).toHaveBeenCalledTimes(1));

    await renderPageOn(queryClient);

    expect(getClusterIndexes).toHaveBeenCalledTimes(1);
    expect(getClusterWorkload).toHaveBeenCalledTimes(1);
  });
});
