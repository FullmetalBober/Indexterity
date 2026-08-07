// The organization you are in: its name, its plan, and who is on it.
//
// It reads one query — the org — where it used to read the `shell` entry and so
// pull the cluster list along with it. Making a NEW organization is not here;
// see the Organizations tab.
import { createFileRoute } from "@tanstack/react-router";
import { OrgSection } from "~/components/app/org-section";
import { useOrg } from "~/lib/queries/shell";

export const Route = createFileRoute("/app/settings/")({
  head: () => ({ meta: [{ title: "Organization — Indexterity" }] }),
  component: OrgPage,
});

function OrgPage() {
  const org = useOrg();
  // The layout renders the auth gate AND the create-org screen, so being here
  // means both have passed. Null is then a read that has not arrived or failed,
  // and an empty page is the same answer the rest of the app gives for a dead
  // read.
  if (org === null) return null;
  return <OrgSection org={org} />;
}
