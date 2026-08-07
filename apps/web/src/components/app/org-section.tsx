import { createInviteInput, renameOrgInput } from "@repo/contracts";
import { useState } from "react";
import { usage } from "~/components/app/format";
import { ConfirmButton } from "~/components/confirm-button";
import { useAppForm } from "~/components/form";
import { TypeToConfirm } from "~/components/type-to-confirm";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import {
  useCancelInvite,
  useCreateInvite,
  useDeleteOrg,
  useLeaveOrg,
  useRemoveMember,
  useRenameOrg,
  useSetMemberRole,
} from "~/lib/queries/mutations/org";

interface OrgDetail {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly plan: {
    readonly plan: string;
    readonly maxClusters: number | null;
    readonly maxMembers: number | null;
    readonly workloadAnalysis: boolean;
    readonly autoApply: boolean;
    readonly clustersUsed: number;
    readonly membersUsed: number;
  };
  readonly members: readonly {
    memberId: string;
    userId: string;
    email: string;
    name: string;
    role: string;
  }[];
  readonly pendingInvites: readonly {
    id: string;
    email: string;
    role: string;
    expiresAt: string;
  }[];
  readonly provisionedUsers: readonly {
    cluster: string;
    username: string;
    revokeCommand: string;
  }[];
}

// The organization you are currently in: what it is called, what it is paying
// for, and who is in it.
//
// Two cards rather than one, because they answer two questions and only one of
// them is dangerous. It was a single "Team — Acme" card holding the plan, a
// rename box, Leave, Delete, the member list, an invite form, the invitations
// somebody had sent YOU, and a form for making an entirely different
// organization — nine things under one heading, and the last of them was not
// even about this org (#81). That one has moved to Settings → Organizations.
export function OrgSection({ org }: { org: OrgDetail }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const setRole = useSetMemberRole();
  const remove = useRemoveMember();
  const leave = useLeaveOrg();
  const rename = useRenameOrg();
  const cancelInvite = useCancelInvite();
  const deleteOrg = useDeleteOrg();
  const invite = useCreateInvite({
    onSent: (email) => {
      setSentTo(email);
      inviteForm.reset();
    },
  });

  const isOwner = org.role === "owner";

  // Two forms rather than one, because they are two unrelated requests: an email
  // that is required to invite is not required to rename an org, and one form
  // would have to say so per field anyway.
  const renameForm = useAppForm({
    defaultValues: { name: org.name },
    onSubmit: ({ value }) => {
      setRenaming(false);
      rename.mutate(value.name);
    },
  });

  const inviteForm = useAppForm({
    defaultValues: { email: "" },
    onSubmit: ({ value }) => invite.mutate(value.email),
  });

  return (
    <>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{org.name}</CardTitle>
          <CardDescription>
            {/* What the plan is and what has been spent of it. The seats half of
                it warns below, next to the invite form that spends them; the
                clusters half warns on the connect page, next to the form that
                spends those. This line is the summary of both, not the warning
                for either. */}
            <span className="inline-flex flex-wrap items-center gap-2">
              <Badge variant="outline">{org.plan.plan}</Badge>
              <span>
                {usage(org.plan.clustersUsed, org.plan.maxClusters)} clusters ·{" "}
                {usage(org.plan.membersUsed, org.plan.maxMembers)} seats
                {org.plan.autoApply ? "" : " · changes need your approval"}
              </span>
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-start gap-2">
          {isOwner && renaming ? (
            <form
              className="flex items-start gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void renameForm.handleSubmit();
              }}
            >
              <renameForm.AppField name="name" validators={{ onChange: renameOrgInput.shape.name }}>
                {(field) => (
                  <field.TextField label="Organization name" hideLabel className="h-8 w-48" />
                )}
              </renameForm.AppField>
              <renameForm.AppForm>
                <renameForm.SubmitButton size="sm" pending={rename.isPending}>
                  Save
                </renameForm.SubmitButton>
              </renameForm.AppForm>
            </form>
          ) : null}
          {isOwner && !renaming ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                renameForm.reset();
                setRenaming(true);
              }}
            >
              Rename
            </Button>
          ) : null}
          <ConfirmButton
            destructive
            trigger={
              <Button variant="ghost" size="sm" className="text-destructive">
                Leave org
              </Button>
            }
            title={`Leave ${org.name}?`}
            description="You lose access to its clusters. The last owner must transfer ownership first."
            confirmLabel="Leave"
            onConfirm={() => leave.mutate(org.id)}
          />
          {isOwner ? (
            <TypeToConfirm
              trigger={
                <Button variant="ghost" size="sm" className="text-destructive">
                  Delete org
                </Button>
              }
              title={`Delete ${org.name}?`}
              phrase={org.name}
              confirmLabel="Delete this organization"
              description={
                <>
                  <p>
                    This removes {org.plan.clustersUsed}{" "}
                    {org.plan.clustersUsed === 1 ? "cluster" : "clusters"}, every recommendation,
                    snapshot and audit row behind them, and every membership. It cannot be undone.
                  </p>
                  <p>
                    Indexes we hid during an observe window are restored on your cluster first, so
                    nothing is left switched off.
                  </p>
                  {/* The one thing deletion cannot clean up, said before the
                      record of it disappears with the org. */}
                  {org.provisionedUsers.length > 0 ? (
                    <>
                      <p className="text-foreground">
                        These database users were created by Indexterity and will be left on your
                        servers. Nothing after this point will remember them:
                      </p>
                      <ul className="space-y-1">
                        {org.provisionedUsers.map((entry) => (
                          <li key={`${entry.cluster}:${entry.username}`}>
                            <span className="font-medium">{entry.cluster}</span> —{" "}
                            <code className="font-mono text-xs">{entry.revokeCommand}</code>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </>
              }
              onConfirm={() => deleteOrg.mutate(org.id)}
            />
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Members</CardTitle>
          <CardDescription>
            Everyone here can see every cluster in {org.name}. Owners can also change them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-1">
            {org.members.map((member) => (
              <li key={member.userId} className="flex flex-wrap items-center gap-2 text-sm">
                <span>
                  {member.name} <span className="text-muted-foreground">({member.email})</span>
                </span>
                <Badge variant="outline">{member.role}</Badge>
                {isOwner ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setRole.mutate({
                          memberId: member.memberId,
                          role: member.role === "owner" ? "member" : "owner",
                        })
                      }
                    >
                      {member.role === "owner" ? "Make member" : "Make owner"}
                    </Button>
                    <ConfirmButton
                      destructive
                      trigger={
                        <Button variant="ghost" size="sm" className="text-destructive">
                          Remove
                        </Button>
                      }
                      title={`Remove ${member.email}?`}
                      description={`They lose access to every cluster in ${org.name}. Their own account stays, and they can make or join another organization.`}
                      confirmLabel="Remove"
                      onConfirm={() => remove.mutate(member.memberId)}
                    />
                  </>
                ) : null}
              </li>
            ))}
            {org.pendingInvites.map((pending) => (
              <li
                key={pending.id}
                className="flex items-center gap-2 text-muted-foreground text-sm"
              >
                {pending.email}
                <Badge variant="secondary">invited · {pending.role}</Badge>
                {isOwner ? (
                  <Button variant="ghost" size="sm" onClick={() => cancelInvite.mutate(pending.id)}>
                    Cancel
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>

          {isOwner ? (
            <>
              <Separator />
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void inviteForm.handleSubmit();
                }}
              >
                <inviteForm.AppField
                  name="email"
                  validators={{ onChange: createInviteInput.shape.email }}
                >
                  {(field) => (
                    <field.TextField
                      label="Invite a teammate"
                      type="email"
                      className="w-64"
                      placeholder="teammate@company.com"
                    />
                  )}
                </inviteForm.AppField>
                <inviteForm.AppForm>
                  <inviteForm.SubmitButton pending={invite.isPending}>
                    Invite
                  </inviteForm.SubmitButton>
                </inviteForm.AppForm>
              </form>
              {sentTo !== null ? (
                <Alert>
                  <AlertTitle>Invitation sent</AlertTitle>
                  {/* No token to copy any more: the invitation is addressed, and
                      only that address can accept it. */}
                  <AlertDescription>
                    {sentTo} can join from their own Organizations page after signing in.
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
