import { useEffect, useState } from "react";

// False during SSR and during the hydration render, true from the first client
// render onwards. Gate anything the server cannot compute the way the reader
// will see it — their clock, their timezone — so both sides of hydration render
// the same markup and React has nothing to complain about. The real value
// appears a frame later.
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

// The server renders UTC (unambiguous, and what the API stores); the browser
// swaps in the reader's own zone once mounted.
export function formatTimestamp(iso: string, mounted: boolean): string {
  const date = new Date(iso);
  if (!mounted) return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return date.toLocaleString();
}
