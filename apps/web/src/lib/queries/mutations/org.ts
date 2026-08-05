// Everything that changes an org, or which org you are in.
//
// Three different blast radii live here, and the difference is the reason this is
// not one hook shape:
//
//   the org       members, roles, invites — one key, and the team page is the
//                 only thing that reads it
//   org + orgs    a rename, because the name appears in the active org AND in the
//                 switcher's list of the caller's orgs
//   the session   leaving, joining, switching — the api resolves a DIFFERENT
//                 membership afterwards, so the clusters and everything under
//                 them answer a question nobody is asking any more
//
// The components used to choose between them through two callback props, which
// meant a member list had to know what a cache is.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { api } from "../../api";
import { invalidateSession } from "../client";
import { apiMessage } from "../errors";
import { queryKeys } from "../keys";

function useInvalidateOrg(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.org() });
}

function useInvalidateSession(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => invalidateSession(queryClient);
}

export function useRenameOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api().renameOrg({ name }),
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
    onError: () => toast.error("Rename failed (owner only)"),
  });
}

export function useSetMemberRole() {
  const invalidateOrg = useInvalidateOrg();
  return useMutation({
    mutationFn: (change: { userId: string; role: "member" | "owner" }) =>
      api().setMemberRole(change),
    onSuccess: (_result, change) => {
      toast.success(`Role changed to ${change.role}`);
      return invalidateOrg();
    },
    // The api refuses to demote the last owner, and its reason is the useful
    // one — a generic "failed" leaves the reader guessing.
    onError: (error) => toast.error(apiMessage(error, "Role change failed")),
  });
}

export function useRemoveMember() {
  const invalidateOrg = useInvalidateOrg();
  return useMutation({
    mutationFn: (userId: string) => api().removeMember({ userId }),
    onSuccess: () => {
      toast.success("Member removed");
      return invalidateOrg();
    },
    onError: (error) => toast.error(apiMessage(error, "Remove failed")),
  });
}

// The token is shown once and never again, so it goes to the caller rather than
// into a toast that scrolls away.
export function useCreateInvite({ onToken }: { onToken: (token: string) => void }) {
  const invalidateOrg = useInvalidateOrg();
  return useMutation({
    mutationFn: (email: string) => api().createInvite({ email, role: "member" }),
    onSuccess: (invite) => {
      onToken(invite.token);
      return invalidateOrg();
    },
    // Used to leave the reader looking at a form that had visibly done nothing:
    // no token, no error, no way to tell which.
    onError: () => toast.error("Invite not created — you may be at your plan's seat limit"),
  });
}

export function useAcceptInvite({ onAnswer }: { onAnswer: (message: string) => void }) {
  const invalidateSessionCache = useInvalidateSession();
  return useMutation({
    mutationFn: (token: string) => api().acceptInvite({ token }),
    onSuccess: (joined) => {
      onAnswer(`joined ${joined.orgName}`);
      // Joining can make another org the active one, so this is a session
      // change and not an org change.
      return invalidateSessionCache();
    },
    // 404 is a token that does not exist or has expired, 409 an org the reader
    // is already in. Both say what to do next; anything else does not.
    onError: (error) => onAnswer(apiMessage(error, "could not accept the invite", [404, 409])),
  });
}

export function useLeaveOrg() {
  const invalidateSessionCache = useInvalidateSession();
  return useMutation({
    mutationFn: () => api().leaveOrg({}),
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
    mutationFn: (orgId: string) => api().switchOrg({ orgId }),
    onSuccess: async (switched) => {
      toast.success(`Switched to ${switched.name}`);
      // The selected cluster belongs to the previous org — reset the selection.
      await navigate({ to: "/app", search: {} });
      await invalidateSessionCache();
    },
    // Nothing moved, so nothing is refetched and the selection stays.
    onError: () => toast.error("Org switch failed"),
  });
}
