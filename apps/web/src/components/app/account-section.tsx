import { changePasswordInput, updateNameInput } from "@repo/contracts";
import { useAppForm } from "~/components/form";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { FieldGroup } from "~/components/ui/field";
import { Separator } from "~/components/ui/separator";
import type { Me, ProviderAccount, SessionEntry } from "~/lib/queries/account";
import {
  useChangePassword,
  useRevokeOtherSessions,
  useRevokeSession,
  useUpdateName,
} from "~/lib/queries/mutations/account";

// A user-agent string is written for machines; the row is read by a person
// deciding whether a session is theirs. Browser and platform are the two words
// that decide it, and "Unknown device" is the honest answer for a curl.
//
// Order is load-bearing on both sides: Chrome's string contains "Safari/",
// Edge's contains "Chrome/", and Android's contains "Linux".
export function describeAgent(userAgent: string | null | undefined): string {
  const agent = userAgent ?? "";
  const browser = agent.includes("Edg/")
    ? "Edge"
    : agent.includes("OPR/")
      ? "Opera"
      : agent.includes("Firefox/")
        ? "Firefox"
        : agent.includes("Chrome/")
          ? "Chrome"
          : agent.includes("Safari/")
            ? "Safari"
            : null;
  const platform = agent.includes("Windows")
    ? "Windows"
    : agent.includes("Android")
      ? "Android"
      : agent.includes("iPhone") || agent.includes("iPad")
        ? "iOS"
        : agent.includes("Mac OS X")
          ? "macOS"
          : agent.includes("Linux")
            ? "Linux"
            : null;
  if (browser === null && platform === null) return "Unknown device";
  if (browser === null) return platform as string;
  if (platform === null) return browser;
  return `${browser} on ${platform}`;
}

// With the year, unlike the drop dates elsewhere: a forgotten session is
// exactly the row that is old enough for "12 Mar" to be ambiguous.
function fmtDay(date: Date | string): string {
  return new Date(date).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function ProfileCard({ me }: { me: Me }) {
  const rename = useUpdateName();
  const form = useAppForm({
    defaultValues: { name: me.user.name },
    onSubmit: ({ value }) => rename.mutate(value.name),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.AppField name="name" validators={{ onChange: updateNameInput.shape.name }}>
            {(field) => (
              <field.TextField
                label="Name"
                className="w-64"
                description="What teammates see in the member list."
              />
            )}
          </form.AppField>
          <form.AppForm>
            <form.SubmitButton pending={rename.isPending}>Save</form.SubmitButton>
          </form.AppForm>
        </form>
        <Separator />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{me.user.email}</span>
          {/* Sign-in and every notice go to this address, so whether it is
              verified is worth a word — but there is no change-email flow, and
              a control that is not here should not be implied. */}
          <Badge variant={me.user.emailVerified ? "outline" : "secondary"}>
            {me.user.emailVerified ? "verified" : "unverified"}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function PasswordCard({ accounts }: { accounts: readonly ProviderAccount[] }) {
  const form = useAppForm({
    defaultValues: { current: "", password: "", confirm: "", revokeOthers: true },
    onSubmit: ({ value }) =>
      change.mutate({
        currentPassword: value.current,
        newPassword: value.password,
        revokeOtherSessions: value.revokeOthers,
      }),
  });
  const change = useChangePassword({ onDone: () => form.reset() });

  // Password is a sign-in method this account may simply not have — someone
  // who arrived through GitHub has nothing here to change, and a form that can
  // only ever answer "invalid password" is worse than saying so.
  const hasPassword = accounts.some((account) => account.providerId === "credential");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Password</CardTitle>
      </CardHeader>
      <CardContent>
        {hasPassword ? (
          <form
            className="flex max-w-sm flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void form.handleSubmit();
            }}
          >
            <FieldGroup className="gap-4">
              <form.AppField
                name="current"
                validators={{ onChange: changePasswordInput.shape.currentPassword }}
              >
                {(field) => (
                  <field.TextField
                    label="Current password"
                    type="password"
                    autoComplete="current-password"
                  />
                )}
              </form.AppField>
              <form.AppField
                name="password"
                validators={{ onChange: changePasswordInput.shape.newPassword }}
              >
                {(field) => (
                  <field.TextField
                    label="New password"
                    type="password"
                    autoComplete="new-password"
                  />
                )}
              </form.AppField>
              <form.AppField
                name="confirm"
                validators={{
                  // The api is sent a single password, so the match is only
                  // ever checked here — same rule as the reset page.
                  onChangeListenTo: ["password"],
                  onChange: ({ value, fieldApi }) =>
                    value === fieldApi.form.getFieldValue("password")
                      ? undefined
                      : "The two do not match",
                }}
              >
                {(field) => (
                  <field.TextField label="Repeat it" type="password" autoComplete="new-password" />
                )}
              </form.AppField>
              <form.AppField name="revokeOthers">
                {(field) => (
                  <field.CheckboxField
                    label="Sign out your other sessions"
                    description="If you are changing it because the old one leaked, this is the half that matters."
                  />
                )}
              </form.AppField>
            </FieldGroup>
            <form.AppForm>
              <form.SubmitButton pending={change.isPending}>Change password</form.SubmitButton>
            </form.AppForm>
          </form>
        ) : (
          <p className="text-muted-foreground text-sm">
            You sign in with GitHub — there is no password on this account to change.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SessionsCard({
  sessions,
  currentToken,
}: {
  sessions: readonly SessionEntry[];
  currentToken: string;
}) {
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();

  // The reader's own row first — it is the one they will recognise, and the
  // anchor for judging the rest.
  const ordered = [...sessions].sort((a, b) => {
    if (a.token === currentToken) return -1;
    if (b.token === currentToken) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sessions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-1">
          {ordered.map((session) => (
            <li key={session.token} className="flex flex-wrap items-center gap-2 text-sm">
              <span>{describeAgent(session.userAgent)}</span>
              {typeof session.ipAddress === "string" && session.ipAddress !== "" ? (
                <span className="font-mono text-muted-foreground text-xs">{session.ipAddress}</span>
              ) : null}
              <span className="text-muted-foreground text-xs">
                signed in {fmtDay(session.createdAt)}
              </span>
              {session.token === currentToken ? (
                <Badge variant="outline">this device</Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => revoke.mutate(session.token)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
        {/* Nothing destructive enough for a dialog: whoever holds the revoked
            cookie can sign back in with the password — this is for the laptop
            left somewhere, not a lockout. */}
        {ordered.length > 1 ? (
          <Button
            variant="outline"
            size="sm"
            disabled={revokeOthers.isPending}
            onClick={() => revokeOthers.mutate()}
          >
            Sign out other sessions
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function AccountSection({
  me,
  sessions,
  accounts,
}: {
  me: Me;
  sessions: readonly SessionEntry[];
  accounts: readonly ProviderAccount[];
}) {
  return (
    <div className="mt-8 space-y-4">
      <ProfileCard me={me} />
      <PasswordCard accounts={accounts} />
      <SessionsCard sessions={sessions} currentToken={me.session.token} />
    </div>
  );
}
