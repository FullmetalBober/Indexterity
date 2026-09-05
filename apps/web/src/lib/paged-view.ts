import type { SortDirection } from "@repo/contracts";
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
//
// Generic over the sort key, because the key reaches the api as a closed enum
// (D135) while the table reports a column id as a string. This hook is where the
// one becomes the other, and the type says which set a view moves within — so
// the request it builds fits the page type derived from the contract (#455)
// without anything in between asserting that a string is a sort key.
export interface PagedRequest<TSort extends string = string> {
  readonly offset: number;
  readonly limit: number;
  readonly sort: TSort;
  readonly dir: SortDirection;
  readonly q?: string | undefined;
}

export interface PagedView<TSort extends string = string> {
  // What the next read asks for. Spread straight into the query.
  readonly request: PagedRequest<TSort>;
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

// Where a view starts, and the set of orders it may move within.
export interface PagedViewInitial<TSort extends string> {
  readonly pageSize: number;
  // The column the api orders by until the reader says otherwise. Its `id` is
  // also the api's sort key — deliberately the same string, so nothing here
  // translates between the header and the query (see `indexSortKey`).
  readonly sort: { readonly id: TSort; readonly desc: boolean };
  // Every key the api can order by: the contract's enum, handed in as its
  // `.options`. A header reports whatever column id it has, and the columns the
  // api cannot order by already say so (`enableSorting: false`), so this is
  // where a string is CHECKED into a sort key rather than asserted to be one. An
  // id outside the set falls back to the initial order, which is also what an
  // empty sorting state does.
  readonly sortKeys: readonly TSort[];
}

// One request from one position, so the hook and `firstPage` cannot disagree
// about what a position asks for.
function requestFor<TSort extends string>(position: {
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly sort: { readonly id: TSort; readonly desc: boolean };
  readonly filter: string;
}): PagedRequest<TSort> {
  const q = position.filter.trim();
  return {
    offset: position.pageIndex * position.pageSize,
    limit: position.pageSize,
    sort: position.sort.id,
    dir: position.sort.desc ? "desc" : "asc",
    // Absent rather than empty: the api validates a minimum length, and an
    // empty parameter in the query string is not the same as no parameter.
    ...(q === "" ? {} : { q }),
  };
}

// The first page of a view, in its default order and unfiltered — what the hook
// asks for on mount, as a pure function, so a route's loader can warm the SAME
// key the component reads (#455). The request is the key now; a loader warming
// `{}` while the component read the first page in full would fill an entry
// nobody reads and leave the tab a skeleton on every SSR.
export function firstPage<TSort extends string>(
  initial: PagedViewInitial<TSort>,
): PagedRequest<TSort> {
  return requestFor({ pageIndex: 0, pageSize: initial.pageSize, sort: initial.sort, filter: "" });
}

export function usePagedView<TSort extends string>(
  initial: PagedViewInitial<TSort>,
): PagedView<TSort> {
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(initial.pageSize);
  const [sorting, setSorting] = useState<SortingState>([initial.sort]);
  const [filter, setFilter] = useState("");

  // Clearing a sort is not a state worth being able to reach — it would mean
  // asking the api for whatever order it happened to produce — so an empty
  // sorting state falls back to the table's own default rather than to none. So
  // does a column id the api has no order for, by the lookup rather than a
  // claim: `find` hands back the key or nothing, never the string.
  const reported = sorting[0];
  const key =
    reported === undefined
      ? undefined
      : initial.sortKeys.find((candidate) => candidate === reported.id);
  const active =
    reported !== undefined && key !== undefined ? { id: key, desc: reported.desc } : initial.sort;

  return {
    request: requestFor({ pageIndex, pageSize, sort: active, filter }),
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
