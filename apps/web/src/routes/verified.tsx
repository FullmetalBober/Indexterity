import { createFileRoute } from "@tanstack/react-router";
import { VerificationOutcome } from "~/components/app/verification-outcome";

// Where the verification email's link lands (#324). Thin on purpose — the page
// itself is a component so it can be rendered in a test without a router, the
// same split verify-email-notice.tsx uses.
export const Route = createFileRoute("/verified")({
  validateSearch: (search: Record<string, unknown>): { error: string } => ({
    error: typeof search.error === "string" ? search.error : "",
  }),
  // Inherits the root's noindex, like /reset-password: a page only reachable
  // from an emailed link has no business in an index.
  head: () => ({ meta: [{ title: "Email confirmed — Indexterity" }] }),
  component: VerifiedPage,
});

function VerifiedPage() {
  const { error } = Route.useSearch();
  return <VerificationOutcome error={error} />;
}
