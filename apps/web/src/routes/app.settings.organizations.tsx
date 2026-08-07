// Every organization the reader belongs to, plus the two ways into another one:
// an invitation addressed to them, and starting their own.
//
// Both used to be at the bottom of the page about the org you were already in —
// the create form only ever showed to somebody who belonged to nowhere, so
// /app/org was the only surface left that could offer a second one (#81).
import { createFileRoute } from "@tanstack/react-router";
import { OrgList } from "~/components/app/org-list";
import { useMyInvites, useOrgs } from "~/lib/queries/shell";

export const Route = createFileRoute("/app/settings/organizations")({
  head: () => ({ meta: [{ title: "Organizations — Indexterity" }] }),
  component: OrgsPage,
});

function OrgsPage() {
  const orgs = useOrgs();
  const invites = useMyInvites();
  return <OrgList orgs={orgs} invites={invites} />;
}
