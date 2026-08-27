// Settings: the organization, the organizations, and the account.
//
// Three sub-sections rather than three top-level tabs. "Your name and password"
// and "this org's members" are both settings, and they were peers of the
// dashboard they configure (#81) — which put the account, a page most readers
// open twice a year, permanently one click from the numbers they came for.
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/settings")({
  // Nothing of its own to fetch: the org, the org list and the reader's
  // invitations all came with the /app layout, and the account's three reads are
  // browser-only and belong to that sub-page.
  head: () => ({ meta: [{ title: "Settings — Indexterity" }] }),
  component: SettingsLayout,
});

const TAB = "-mb-px border-b-2 border-transparent px-1 pb-2";
const TAB_ACTIVE = { className: "border-primary font-medium", "aria-current": "page" as const };
const TAB_INACTIVE = { className: "text-muted-foreground hover:text-foreground" };

function SettingsLayout() {
  return (
    // Capped. Nothing under Settings is a table or a chart — it is member
    // rows, a plan line and a handful of fields, and every one of them reads
    // worse the further its label is from its value.
    <div className="max-w-3xl">
      <h1 className="font-semibold text-2xl">Settings</h1>
      <nav aria-label="Settings" className="mt-4 mb-6 flex gap-4 border-b text-sm">
        <Link
          to="/app/settings"
          activeOptions={{ exact: true }}
          activeProps={TAB_ACTIVE}
          inactiveProps={TAB_INACTIVE}
          className={TAB}
        >
          Organization
        </Link>
        <Link
          to="/app/settings/organizations"
          activeProps={TAB_ACTIVE}
          inactiveProps={TAB_INACTIVE}
          className={TAB}
        >
          Organizations
        </Link>
        {/* Shown to members too, for the same reason as Security below: the
            list is readable by anyone in the org and only the form is
            owner-only, so a tab that vanished would read as "we do not do
            VPNs". */}
        <Link
          to="/app/settings/tunnels"
          activeProps={TAB_ACTIVE}
          inactiveProps={TAB_INACTIVE}
          className={TAB}
        >
          VPN tunnels
        </Link>
        <Link
          to="/app/settings/account"
          activeProps={TAB_ACTIVE}
          inactiveProps={TAB_INACTIVE}
          className={TAB}
        >
          Account
        </Link>
        {/* Shown to everyone and answered for owners only (#158) — the api
            refuses a member with a 403, and the page says so rather than the tab
            disappearing. A tab that is there for some readers and not others is
            how somebody concludes the feature does not exist. */}
        <Link
          to="/app/settings/security"
          activeProps={TAB_ACTIVE}
          inactiveProps={TAB_INACTIVE}
          className={TAB}
        >
          Security
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
