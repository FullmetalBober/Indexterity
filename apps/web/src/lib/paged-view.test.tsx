import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { firstPage, type PagedViewInitial, usePagedView } from "./paged-view";

type Key = "namespace" | "sizeBytes" | "totalOps";

const VIEW: PagedViewInitial<Key> = {
  pageSize: 100,
  sort: { id: "namespace", desc: false },
  sortKeys: ["namespace", "sizeBytes", "totalOps"],
};

function view() {
  return renderHook(() => usePagedView(VIEW));
}

describe("usePagedView", () => {
  // The loader warms `firstPage`; the component asks for `request`. They have to
  // be the same object or the warm-up lands in an entry nobody reads (#455).
  it("starts on the page the loader warms", () => {
    const { result } = view();
    expect(result.current.request).toStrictEqual(firstPage(VIEW));
    expect(firstPage(VIEW)).toStrictEqual({ offset: 0, limit: 100, sort: "namespace", dir: "asc" });
  });

  it("asks for the offset of the page clicked", () => {
    const { result } = view();
    act(() => result.current.onPagination({ pageIndex: 3, pageSize: 100 }));
    expect(result.current.request).toMatchObject({ offset: 300, limit: 100 });
  });

  it("carries a new page size, with the index the table recomputed", () => {
    const { result } = view();
    act(() => result.current.onPagination({ pageIndex: 2, pageSize: 25 }));
    expect(result.current.request).toMatchObject({ offset: 50, limit: 25 });
  });

  // The RESET, which is what the hook exists for: page four by namespace is not
  // page four by size.
  it("goes back to the first page when the order changes", () => {
    const { result } = view();
    act(() => result.current.onPagination({ pageIndex: 3, pageSize: 100 }));
    act(() => result.current.onSorting([{ id: "sizeBytes", desc: true }]));
    expect(result.current.request).toStrictEqual({
      offset: 0,
      limit: 100,
      sort: "sizeBytes",
      dir: "desc",
    });
  });

  it("goes back to the first page when the filter changes, and sends it trimmed", () => {
    const { result } = view();
    act(() => result.current.onPagination({ pageIndex: 3, pageSize: 100 }));
    act(() => result.current.onFilter("  zip "));
    expect(result.current.request).toStrictEqual({
      offset: 0,
      limit: 100,
      sort: "namespace",
      dir: "asc",
      q: "zip",
    });
  });

  // No `q` KEY at all, not `q: undefined`: toStrictEqual tells the two apart.
  it("sends no filter for a blank box", () => {
    const { result } = view();
    act(() => result.current.onFilter("   "));
    expect(result.current.request).toStrictEqual({
      offset: 0,
      limit: 100,
      sort: "namespace",
      dir: "asc",
    });
  });

  // A header the api cannot order by, or no header at all, is the default order
  // — never the string the table reported, and never "whatever the api does".
  it("falls back to the default order for an id outside the api's keys", () => {
    const { result } = view();
    act(() => result.current.onSorting([{ id: "keys", desc: true }]));
    expect(result.current.request).toMatchObject({ sort: "namespace", dir: "asc" });
    act(() => result.current.onSorting([]));
    expect(result.current.request).toMatchObject({ sort: "namespace", dir: "asc" });
  });

  // Where the api put the reader, which past the end of a shrunken set is not
  // where they asked.
  it("draws the served page, and holds the asked-for one against a zero limit", () => {
    const { result } = view();
    act(() => result.current.onPagination({ pageIndex: 5, pageSize: 100 }));
    expect(result.current.servedIndex(200, 100)).toBe(2);
    expect(result.current.servedIndex(0, 0)).toBe(5);
  });
});
