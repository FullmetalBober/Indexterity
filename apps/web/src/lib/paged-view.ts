import type { SortingState } from "@tanstack/react-table";
import { useState } from "react";

// The reader's position in a server-paged table: which page, which order, which
// filter — and the rule that ties them together.
//
// One hook rather than three `useState`s per table, because the interesting part
// is not the state, it is the RESET. Page four of an unfiltered list is not page
// four of the filtered one, and page four by namespace is not page four by size;
// so changing the sort or the filter has to send the reader back to the first
// page. Forgetting that does not throw — it asks the api for an offset the new
// result set may not have, the api clamps (D133), and the reader ends up on a
// page they did not choose, wondering why.
//
// Which side owns all this is D135: a CAPPED read sorts and filters in the
// browser, because the rows that arrived are the whole set the reader was handed
// (D33/D47). A PAGED read cannot, because the server chose which rows arrived.
// This hook is for the second kind, and the three dimensions live together
// because they are one request.
export interface PagedRequest {
  readonly offset: number;
  readonly limit: number;
  readonly sort: string;
  readonly dir: "asc" | "desc";
  readonly q?: string | undefined;
}

export interface PagedView {
  // What the next read asks for. Spread straight into the query.
  readonly request: PagedRequest;
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly sorting: SortingState;
  readonly filter: string;
  readonly onPagination: (next: { pageIndex: number; pageSize: number }) => void;
  readonly onSorting: (next: SortingState) => void;
  readonly onFilter: (next: string) => void;
  // Where the api actually put the reader, which is not always where they asked:
  // past the end of a set that shrank it clamps to the last page. Given the
  // served offset and limit, this is the page index to DRAW.
  readonly servedIndex: (offset: number, limit: number) => number;
}

export function usePagedView(initial: {
  readonly pageSize: number;
  // The column the api orders by until the reader says otherwise. Its `id` is
  // also the api's sort key — deliberately the same string, so nothing here
  // translates between the header and the query (see `indexSortKey`).
  readonly sort: { readonly id: string; readonly desc: boolean };
}): PagedView {
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(initial.pageSize);
  const [sorting, setSorting] = useState<SortingState>([initial.sort]);
  const [filter, setFilter] = useState("");

  // Clearing a sort is not a state worth being able to reach — it would mean
  // asking the api for whatever order it happened to produce — so an empty
  // sorting state falls back to the table's own default rather than to none.
  const active = sorting[0] ?? initial.sort;

  return {
    request: {
      offset: pageIndex * pageSize,
      limit: pageSize,
      sort: active.id,
      dir: active.desc ? "desc" : "asc",
      // Absent rather than empty: the api validates a minimum length, and an
      // empty parameter in the query string is not the same as no parameter.
      ...(filter.trim() === "" ? {} : { q: filter.trim() }),
    },
    pageIndex,
    pageSize,
    sorting,
    filter,
    onPagination: (next) => {
      setPageIndex(next.pageIndex);
      setPageSize(next.pageSize);
    },
    onSorting: (next) => {
      setSorting(next);
      setPageIndex(0);
    },
    onFilter: (next) => {
      setFilter(next);
      setPageIndex(0);
    },
    servedIndex: (offset, limit) => (limit > 0 ? Math.floor(offset / limit) : pageIndex),
  };
}
