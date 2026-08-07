import { Label as LabelPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "~/lib/utils";

// The one divergence from the registry's label.tsx: shadcn ships this with
// `select-none`. Upstream's reasoning is that a label is a click target for its
// control, so double-clicking one should focus the input rather than highlight a
// word. That is true of a checkbox row and false of everything else here — the
// labels in this app name a namespace, a username, a cluster id, a knob whose
// exact spelling the reader is about to grep for, and text that refuses to
// highlight reads as a broken page.
//
// The toggle case keeps it, one call site at a time: `CheckboxField` in
// components/form.tsx passes `select-none` back in.
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
