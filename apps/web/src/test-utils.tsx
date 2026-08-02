import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { TooltipProvider } from "~/components/ui/tooltip";

// The providers routes/__root.tsx wraps every page in. A component rendered
// without them throws on its first tooltip, which is a failure about the test
// harness rather than about the component — so anything using one renders
// through here instead of bare render().
function Providers({ children }: { children: ReactNode }) {
  return <TooltipProvider delayDuration={0}>{children}</TooltipProvider>;
}

export function renderInApp(ui: ReactElement): RenderResult {
  return render(ui, { wrapper: Providers });
}
