// The signed-in user's own account: name, password, sessions. Nothing here is
// about an org — it is the same page whichever one is active — so it reads
// none of the org-level queries at all.
import { createFileRoute } from "@tanstack/react-router";
import { AccountSection } from "~/components/app/account-section";
import { useMe, useMyAccounts, useMySessions } from "~/lib/queries/account";

export const Route = createFileRoute("/app/account")({
  head: () => ({ meta: [{ title: "Account — Indexterity" }] }),
  component: AccountPage,
});

function AccountPage() {
  const me = useMe();
  const sessions = useMySessions();
  const accounts = useMyAccounts();
  // Browser-only reads (lib/queries/account.ts), so this is the whole SSR
  // render and the first client one. The layout has already decided the reader
  // is signed in; null past that is a read that has not arrived or failed, and
  // an empty page is the app's usual answer for a dead read.
  if (me === null) return null;
  return <AccountSection me={me} sessions={sessions} accounts={accounts} />;
}
