import { acceptInviteInput, createInviteInput, renameOrgInput } from "@repo/contracts";
import { useState } from "react";
import { ConfirmButton } from "~/components/confirm-button";
import { useAppForm } from "~/components/form";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import {
  useAcceptInvite,
  useCreateInvite,
  useLeaveOrg,
  useRemoveMember,
  useRenameOrg,
  useSetMemberRole,
} from "~/lib/queries/mutations/org";

interface TeamOrg {
  readonly name: string;
  readonly plan: {
    readonly plan: string;
    readonly maxClusters: number | null;
    readonly maxMembers: number | null;
    readonly workloadAnalysis: boolean;
    readonly autoApply: boolean;
    readonly clustersUsed: number;
    readonly membersUsed: number;
  };
  readonly members: readonly { userId: string; email: string; name: string; role: string }[];
  readonly pendingInvites: readonly { email: string; role: string; expiresAt: string }[];
}

// "2 / 3" while there is a cap, the bare count when there is not.
function usage(used: number, limit: number | null): string {
  return limit === null ? String(used) : `${used} / ${limit}`;
}

export function TeamSection({ org }: { org: TeamOrg }) {
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [acceptMessage, setAcceptMessage] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const setRole = useSetMemberRole();
  const remove = useRemoveMember();
  const leave = useLeaveOrg();
  const rename = useRenameOrg();
  const invite = useCreateInvite({
    onToken: (token) => {
      setInviteToken(token);
      inviteForm.reset();
    },
  });
  const accept = useAcceptInvite({
    onAnswer: (message) => {
      setAcceptMessage(message);
      acceptForm.reset();
    },
  });

  // Three forms rather than one, because they are three unrelated requests that
  // happen to share a card: an email that is required to invite is not required
  // to rename an org, and one form would have to say so per field anyway.
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

  const acceptForm = useAppForm({
    defaultValues: { token: "" },
    onSubmit: ({ value }) => accept.mutate(value.token),
  });

  return (
    <Card className="mt-8">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Team — {org.name}</CardTitle>
          {/* The limit is worth showing BEFORE it is hit: the alternative is a
              402 at the moment someone is trying to get work done. */}
          <Badge variant="outline">{org.plan.plan}</Badge>
          <span className="text-muted-foreground text-xs">
            {usage(org.plan.clustersUsed, org.plan.maxClusters)} clusters ·{" "}
            {usage(org.plan.membersUsed, org.plan.maxMembers)} seats
            {org.plan.autoApply ? "" : " · changes need your approval"}
          </span>
          {renaming ? (
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
          ) : (
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
          )}
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
            onConfirm={() => leave.mutate()}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-1">
          {org.members.map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center gap-2 text-sm">
              <span>
                {member.name} <span className="text-muted-foreground">({member.email})</span>
              </span>
              <Badge variant="outline">{member.role}</Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setRole.mutate({
                    userId: member.userId,
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
                description={`They lose access to every cluster in ${org.name}. Their own account stays, in a fresh empty organization.`}
                confirmLabel="Remove"
                onConfirm={() => remove.mutate(member.userId)}
              />
            </li>
          ))}
          {org.pendingInvites.map((invite) => (
            <li
              key={invite.email}
              className="flex items-center gap-2 text-muted-foreground text-sm"
            >
              {invite.email}
              <Badge variant="secondary">invited · {invite.role}</Badge>
            </li>
          ))}
        </ul>

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
            <inviteForm.SubmitButton pending={invite.isPending}>Invite</inviteForm.SubmitButton>
          </inviteForm.AppForm>
        </form>
        {inviteToken !== null ? (
          <Alert>
            <AlertTitle>Invite created</AlertTitle>
            <AlertDescription>
              Share this token: <code className="font-mono">{inviteToken}</code>
            </AlertDescription>
          </Alert>
        ) : null}

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void acceptForm.handleSubmit();
          }}
        >
          <acceptForm.AppField
            name="token"
            validators={{ onChange: acceptInviteInput.shape.token }}
          >
            {(field) => (
              <field.TextField
                label="Have an invite token?"
                className="w-64 font-mono"
                placeholder="Paste an invite token"
              />
            )}
          </acceptForm.AppField>
          <acceptForm.AppForm>
            <acceptForm.SubmitButton variant="outline" pending={accept.isPending}>
              Join org
            </acceptForm.SubmitButton>
          </acceptForm.AppForm>
        </form>
        {acceptMessage !== null ? (
          <p className="text-muted-foreground text-sm">{acceptMessage}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
