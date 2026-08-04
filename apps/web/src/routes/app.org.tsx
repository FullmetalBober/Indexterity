// Organization: members, roles, invites and the plan.
//
// A route rather than a section at the bottom of the dashboard, because none
// of it is about a cluster. Opening it no longer pulls a latency series, seven
// per-cluster reads, or anything else it does not render — the org data it
// needs is already in the layout's loader.
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { TeamSection } from "~/components/app/team-section";
import { invalidateSession, queryKeys } from "~/lib/query";
import { useShell } from "~/lib/shell";

export const Route = createFileRoute("/app/org")({
  head: () => ({ meta: [{ title: "Organization — Indexterity" }] }),
  component: OrgPage,
});

function OrgPage() {
  const shell = useShell();
  const queryClient = useQueryClient();
  // The layout renders the auth gate; if we are here it has already passed,
  // and this narrows the union for the compiler.
  if (!shell.authed) return null;
  // Members, roles, invites and the plan all live in the shell, so a change to
  // any of them refetches that one key. The route does not re-run.
  //
  // Leaving an org, or joining one, is the exception: the api resolves a
  // different membership from then on, so the clusters and everything under
  // them are answers to a question that is no longer being asked.
  return (
    <TeamSection
      org={shell.org}
      onChanged={() => void queryClient.invalidateQueries({ queryKey: queryKeys.shell() })}
      onActiveOrgChanged={() => void invalidateSession(queryClient)}
    />
  );
}
