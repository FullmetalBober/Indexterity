// Everything that changes an org, or which org you are in.
//
// Two different blast radii live here, and the difference is the reason this is
// not one hook shape:
//
//   the shell     members, roles, invites, the org's name — one key
//   the session   leaving, joining, switching — the api resolves a DIFFERENT
//                 membership afterwards, so the clusters and everything under
//                 them answer a question nobody is asking any more
//
// The components used to choose between them through two callback props, which
// meant a member list had to know what a cache is.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  acceptInvite,
  createInvite,
  leaveOrg,
  removeMember,
  renameOrg,
  setMemberRole,
  switchOrgFn,
} from "../../app-server";
import { invalidateSession } from "../client";
import { queryKeys } from "../keys";

function useInvalidateOrg(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.shell() });
}

function useInvalidateSession(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => invalidateSession(queryClient);
}

export function useRenameOrg() {
  const invalidateOrg = useInvalidateOrg();
  return useMutation({
    mutationFn: (name: string) => renameOrg({ data: name }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error("Rename failed (owner only)");
        return;
      }
      toast.success("Org renamed");
      return invalidateOrg();
    },
    onError: () => toast.error("Rename failed (owner only)"),
  });
}

export function useSetMemberRole() {
  const invalidateOrg = useInvalidateOrg();
  return useMutation({
    mutationFn: (change: { userId: string; role: "member" | "owner" }) =>
      setMemberRole({ data: change }),
    onSuccess: (result, change) => {
      // The api refuses to demote the last owner, and its reason is the useful
      // one — a generic "failed" leaves the reader guessing.
      if (!result.ok) {
        toast.error(result.message ?? "Role change failed");
        return;
      }
      toast.success(`Role changed to ${change.role}`);
      return invalidateOrg();
    },
    onError: () => toast.error("Role change failed"),
  });
}

export function useRemoveMember() {
  const invalidateOrg = useInvalidateOrg();
  return useMutation({
    mutationFn: (userId: string) => removeMember({ data: userId }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message ?? "Remove failed");
        return;
      }
      toast.success("Member removed");
      return invalidateOrg();
    },
    onError: () => toast.error("Remove failed"),
  });
}

// The token is shown once and never again, so it goes to the caller rather than
// into a toast that scrolls away.
export function useCreateInvite({ onToken }: { onToken: (token: string) => void }) {
  const invalidateOrg = useInvalidateOrg();
  return useMutation({
    mutationFn: (email: string) => createInvite({ data: email }),
    onSuccess: (result) => {
      if (result.token === null) {
        // Used to leave the reader looking at a form that had visibly done
        // nothing: no token, no error, no way to tell which.
        toast.error("Invite not created — you may be at your plan's seat limit");
        return;
      }
      onToken(result.token);
      return invalidateOrg();
    },
    onError: () => toast.error("Invite not created"),
  });
}

export function useAcceptInvite({ onAnswer }: { onAnswer: (message: string) => void }) {
  const invalidateSessionCache = useInvalidateSession();
  return useMutation({
    mutationFn: (token: string) => acceptInvite({ data: token }),
    onSuccess: (result) => {
      onAnswer(result.message);
      // Joining can make another org the active one, so this is a session
      // change and not an org change.
      if (result.ok) return invalidateSessionCache();
    },
    onError: () => onAnswer("could not accept the invite"),
  });
}

export function useLeaveOrg() {
  const invalidateSessionCache = useInvalidateSession();
  return useMutation({
    mutationFn: () => leaveOrg({ data: {} }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.message ?? "Leave failed");
        return;
      }
      toast.success("Left the org");
      return invalidateSessionCache();
    },
    onError: () => toast.error("Leave failed"),
  });
}

export function useSwitchOrg() {
  const invalidateSessionCache = useInvalidateSession();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (orgId: string) => switchOrgFn({ data: orgId }),
    onSuccess: async (result) => {
      if (!result.ok) {
        // Nothing moved, so nothing is refetched and the selection stays.
        toast.error("Org switch failed");
        return;
      }
      toast.success(`Switched to ${result.name ?? "org"}`);
      // The selected cluster belongs to the previous org — reset the selection.
      await navigate({ to: "/app", search: {} });
      await invalidateSessionCache();
    },
    onError: () => toast.error("Org switch failed"),
  });
}
