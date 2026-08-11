import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";

// One line, clipped with an ellipsis, and a tooltip carrying the rest — but only
// when there IS a rest.
//
// A tooltip on every cell is noise: it covers the row under the pointer to tell
// the reader what they are already looking at. So this measures instead, and the
// measurement is the whole component: `scrollWidth > clientWidth` is the browser
// saying the text did not fit, which is exactly the question. Re-asked on resize,
// because the answer changes when the window does and a cell that fitted at
// 1920px does not at 1280.
//
// `title` is deliberately not used for this. It cannot be styled or read by a
// keyboard, it waits a second or two on its own schedule, and where a cell is
// already inside a Tooltip the two stack — the browser's box on top of ours.
function useOverflowing(): {
  overflowing: boolean;
  ref: (node: HTMLElement | null) => void;
} {
  const [overflowing, setOverflowing] = useState(false);
  const nodeRef = useRef<HTMLElement | null>(null);

  const measure = useCallback((node: HTMLElement | null) => {
    if (node === null) return;
    // A pixel of tolerance: sub-pixel layout makes scrollWidth exceed clientWidth
    // by fractions on text that is plainly not clipped, which would put a tooltip
    // on nearly every cell.
    setOverflowing(node.scrollWidth - node.clientWidth > 1);
  }, []);

  // A callback ref rather than useEffect on a stable ref, so the first measurement
  // happens when the node arrives rather than a frame later — the tooltip is then
  // available to the first hover instead of the second.
  const ref = useCallback(
    (node: HTMLElement | null) => {
      nodeRef.current = node;
      measure(node);
    },
    [measure],
  );

  useEffect(() => {
    // Guarded for the server render, where there is no layout to measure and no
    // ResizeObserver to ask. The client measures on mount.
    if (typeof ResizeObserver === "undefined") return;
    const node = nodeRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(() => measure(node));
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  return { overflowing, ref };
}

export function Truncated({
  children,
  className,
  // What the tooltip carries. Defaults to the text itself; pass it when the cell
  // draws something the string alone does not describe.
  full,
}: {
  children: string;
  className?: string;
  full?: ReactNode;
}) {
  const { overflowing, ref } = useOverflowing();
  const text = (
    <span
      ref={ref}
      className={className === undefined ? "block truncate" : `block truncate ${className}`}
    >
      {children}
    </span>
  );
  if (!overflowing) return text;
  return (
    <Tooltip>
      {/* `asChild`: the trigger has to BE the element being measured. Left to wrap
          its child, the trigger becomes the clipped box and the span inside it
          measures its own full width, so nothing ever reads as overflowing. */}
      <TooltipTrigger asChild>{text}</TooltipTrigger>
      {/* Wrapped rather than one line — the tooltip exists because the line did
          not fit, so repeating it on one line would not help. */}
      <TooltipContent className="max-w-sm text-wrap">{full ?? children}</TooltipContent>
    </Tooltip>
  );
}
