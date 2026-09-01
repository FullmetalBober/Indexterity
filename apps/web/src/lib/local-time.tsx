// The component half of the hydration gate. `useMounted` and `formatTimestamp`
// next door are the primitives a caller drives itself; this is the one that
// drives them for the caller, which is the difference the comment below is about.

import { instantOf } from "~/lib/instant";
import { useMounted } from "./hydration";

// One timestamp, drawn the only way a server can draw one honestly.
//
// A component rather than another `(iso, mounted)` helper, because the bug this
// exists to stop is not a formatting bug — it is FORGETTING. Four components
// formatted a timestamp with `toLocaleString(undefined, …)` and never took the
// mounted gate, which renders the server's zone into the HTML and the reader's
// into the hydration pass: React finds "Aug 19, 2026, 04:06 PM" where the server
// wrote "Aug 19, 2026, 01:06 PM", calls the tree poisoned and throws away the
// whole page. Threading a boolean is something a call site can omit; asking for
// a component is not.
//
// `options` is per call site on purpose — a session list wants the year and a
// drop date three weeks out does not — but the SSR branch is here, once.
export function LocalTime({
  iso,
  options,
  dateOnly = false,
}: {
  readonly iso: string;
  readonly options?: Intl.DateTimeFormatOptions;
  // Days are not immune. Three hours of offset moves a date across midnight, so
  // "19 Aug" and "20 Aug" are the same mismatch with a narrower window — and a
  // narrower window is worse, because it fails for one reader in the evening and
  // nobody can reproduce it.
  readonly dateOnly?: boolean;
}) {
  const mounted = useMounted();
  const date = instantOf(iso);
  if (date === null) return <>—</>;
  if (!mounted) {
    const utc = date.toISOString();
    return <>{dateOnly ? utc.slice(0, 10) : `${utc.slice(0, 16).replace("T", " ")} UTC`}</>;
  }
  return (
    <>
      {dateOnly
        ? date.toLocaleDateString(undefined, options)
        : date.toLocaleString(undefined, options)}
    </>
  );
}
