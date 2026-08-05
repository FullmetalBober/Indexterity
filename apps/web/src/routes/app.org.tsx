// Organization: members, roles, invites and the plan.
//
// A route rather than a section at the bottom of the dashboard, because none of
// it is about a cluster. It now reads exactly one query — the org — where it used
// to read the `shell` entry and so pull the cluster list along with it.
import { createFileRoute } from "@tanstack/react-router";
import { TeamSection } from "~/components/app/team-section";
import { useOrg } from "~/lib/queries/shell";

export const Route = createFileRoute("/app/org")({
  head: () => ({ meta: [{ title: "Organization — Indexterity" }] }),
  component: OrgPage,
});

function OrgPage() {
  const org = useOrg();
  // The layout renders the auth gate, so being here means it has passed. Null is
  // then a read that has not arrived or failed, and an empty page is the same
  // answer the rest of the app gives for a dead read.
  if (org === null) return null;
  return <TeamSection org={org} />;
}
