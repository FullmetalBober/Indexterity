// Everything that changes an org, or which org you are in.
//
// None of it is an api call any more. better-auth's organization plugin owns
// create, rename, delete, invite, accept, reject, role, remove, leave and
// switch; what is left here is the part react-query cares about — which cached
// answers each of those makes wrong.
//
// Three different blast radii live here, and the difference is the reason this is
// not one hook shape:
//
//   the org       members, roles, invites — one key, and the team page is the
//                 only thing that reads it
//   org + orgs    a rename, because the name appears in the active org AND in the
//                 switcher's list of the caller's orgs
//   the session   creating, deleting, leaving, joining, switching — a DIFFERENT
//                 org answers everything afterwards, so the clusters and
//                 everything under them answer a question nobody is asking
//
// The components used to choose between them through two callback props, which
// meant a member list had to know what a cache is.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { authClient } from "../../auth-client";
import { invalidateSession } from "../client";
import { AuthApiError, apiMessage, unwrap } from "../errors";
import { queryKeys } from "../keys";

// A slug is required and unique and nothing routes by it — it exists because the
// plugin resolves organizations by one. Derived from the name so the common case
// reads like the org; useCreateOrg retries with a suffix when the clean one is
// taken, rather than making a reader invent a second name for the same company.
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base === "" ? "org" : base;
}

function suffixed(slug: string): string {
  return `${slug}-${Math.random().toString(36).slice(2, 8)}`;
}

function useInvalidateOrg(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.org() });
}

function useInvalidateSession(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => invalidateSession(queryClient);
}

// Creating one, which used to happen TO you rather than be something you did:
// the api inserted "My Org" behind your first authenticated request.
export function useCreateOrg() {
  const invalidateSessionCache = useInvalidateSession();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (name: string) => {
      const slug = slugify(name);
      try {
        return await unwrap(authClient.organization.create({ name, slug }));
      } catch (error) {
        // The clean slug is global, so the second company called Acme would
        // otherwise be told its name is taken — which it is not, and which the
        // reader can neither see nor fix, because the slug is never shown.
        if (error instanceof AuthApiError && error.status === 400) {
          return await unwrap(authClient.organization.create({ name, slug: suffixed(slug) }));
        }
        throw error;
      }
    },
    onSuccess: async (created) => {
      toast.success(`Created ${created.name}`);
      // The plugin makes the new org active, so this is a session change.
      await invalidateSessionCache();
      // And a session change with somewhere to be: a brand-new org has no
      // clusters, so /app lands on connecting one. Without this, making an org
      // from the settings page silently swapped which org every other page was
      // about and left the reader looking at a list.
      await navigate({ to: "/app" });
    },
    // 402 is the free-org cap, and it names the plan and the remedy.
    onError: (error) => toast.error(apiMessage(error, "Could not create the organization")),
  });
}

export function useRenameOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => unwrap(authClient.organization.update({ data: { name } })),
    onSuccess: async () => {
      toast.success("Org renamed");
      // Both, because the name is drawn twice: the team card's title reads the
      // active org, the switcher reads the list. Invalidating one left the other
      // showing the old name until something else moved it.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.org() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orgs() }),
      ]);
    },
    onError: (error) => toast.error(apiMessage(error, "Rename failed (owner only)")),
  });
}

// The dangerous one. The dialog above it types the org's name out in full and
// lists the provisioned users the deletion cannot revoke — see TeamSection.
export function useDeleteOrg() {
  const invalidateSessionCache = useInvalidateSession();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (organizationId: string) =>
      unwrap(authClient.organization.delete({ organizationId })),
    onSuccess: async () => {
      toast.success("Organization deleted");
      // Same order as the switch below, for the same reason: the loader behind
      // the navigation reads whatever is cached, and what is cached is the org
      // that no longer exists.
      await invalidateSessionCache();
      // Whatever page this was is about an org that no longer exists.
      await navigate({ to: "/app" });
    },
    onError: (error) => toast.error(apiMessage(error, "Delete failed (owner only)")),
  });
}

export function useSetMemberRole() {
  const invalidateOrg = useInvalidateOrg();
  return useMutation({
    mutationFn: (change: { memberId: string; role: "member" | "owner" }) =>
      unwrap(authClient.organization.updateMemberRole(change)),
    onSuccess: (_result, change) => {
      toast.success(`Role changed to ${change.role}`);
      return invalidateOrg();
    },
    // The plugin refuses to demote the last owner, and its reason is the useful
    // one — a generic "failed" leaves the reader guessing.
    onError: (error) => toast.error(apiMessage(error, "Role change failed")),
  });
}

export function useRemoveMember() {
  const invalidateOrg = useInvalidateOrg();
  return useMutation({
    mutationFn: (memberIdOrEmail: string) =>
      unwrap(authClient.organization.removeMember({ memberIdOrEmail })),
    onSuccess: () => {
      toast.success("Member removed");
      return invalidateOrg();
    },
    onError: (error) => toast.error(apiMessage(error, "Remove failed")),
  });
}

// No token comes back and none is shown. The invitation goes to the address, and
// only that address can accept it — so there is nothing here for the inviter to
// copy, and nothing to leak if they did.
export function useCreateInvite({ onSent }: { onSent: (email: string) => void }) {
  const invalidateOrg = useInvalidateOrg();
  return useMutation({
    mutationFn: (email: string) =>
      unwrap(authClient.organization.inviteMember({ email, role: "member" })),
    onSuccess: async (_invite, email) => {
      onSent(email);
      await invalidateOrg();
    },
    // Used to leave the reader looking at a form that had visibly done nothing:
    // no token, no error, no way to tell which. 402 is the seat limit and names
    // the plan and the remedy.
    onError: (error) =>
      toast.error(apiMessage(error, "Invite not sent — you may be at your plan's seat limit")),
  });
}

export function useCancelInvite() {
  const invalidateOrg = useInvalidateOrg();
  return useMutation({
    mutationFn: (invitationId: string) =>
      unwrap(authClient.organization.cancelInvitation({ invitationId })),
    onSuccess: () => {
      toast.success("Invite cancelled");
      return invalidateOrg();
    },
    onError: (error) => toast.error(apiMessage(error, "Could not cancel that invite")),
  });
}

// Accepting one addressed to you. The plugin makes that org the active one,
// which is what the click meant, so this is a session change and not an org one.
export function useAcceptInvite() {
  const invalidateSessionCache = useInvalidateSession();
  return useMutation({
    mutationFn: (invitationId: string) =>
      unwrap(authClient.organization.acceptInvitation({ invitationId })),
    onSuccess: async () => {
      toast.success("Joined the organization");
      await invalidateSessionCache();
    },
    onError: (error) => toast.error(apiMessage(error, "Could not accept that invitation")),
  });
}

export function useRejectInvite() {
  const invalidateSessionCache = useInvalidateSession();
  return useMutation({
    mutationFn: (invitationId: string) =>
      unwrap(authClient.organization.rejectInvitation({ invitationId })),
    onSuccess: () => invalidateSessionCache(),
    onError: (error) => toast.error(apiMessage(error, "Could not decline that invitation")),
  });
}

export function useLeaveOrg() {
  const invalidateSessionCache = useInvalidateSession();
  return useMutation({
    mutationFn: (organizationId: string) =>
      unwrap(authClient.organization.leave({ organizationId })),
    onSuccess: () => {
      toast.success("Left the org");
      return invalidateSessionCache();
    },
    onError: (error) => toast.error(apiMessage(error, "Leave failed")),
  });
}

export function useSwitchOrg() {
  const invalidateSessionCache = useInvalidateSession();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (organizationId: string) =>
      unwrap(authClient.organization.setActive({ organizationId })),
    onSuccess: async (switched) => {
      toast.success(`Switched to ${switched?.name ?? "the org"}`);
      // The invalidation FIRST, then the navigation. Navigating runs the
      // dashboard's loader, and its ensureQueryData calls resolve from the cache
      // whether the entries are stale or not — so with the old order the loader
      // read the previous org's cluster list, picked a cluster this org does not
      // own, and spent seven requests warming keys for it (#82).
      await invalidateSessionCache();
      // Whichever cluster page this was, it belongs to the org just left. /app
      // resolves the new org's first cluster, or the connect page if it has
      // none.
      await navigate({ to: "/app" });
    },
    // Nothing moved, so nothing is refetched and the selection stays.
    onError: () => toast.error("Org switch failed"),
  });
}
