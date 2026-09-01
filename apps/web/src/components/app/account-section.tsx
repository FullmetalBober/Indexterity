import { changeEmailInput, changePasswordInput, updateNameInput } from "@repo/contracts";
import { useState } from "react";
import QRCode from "react-qr-code";
import { useAppForm } from "~/components/form";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { FieldGroup } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Separator } from "~/components/ui/separator";
import { millisOf } from "~/lib/instant";
import { LocalTime } from "~/lib/local-time";
import type { Me, ProviderAccount, SessionEntry } from "~/lib/queries/account";
import {
  useChangeEmail,
  useChangePassword,
  useRevokeOtherSessions,
  useRevokeSession,
  useUpdateName,
} from "~/lib/queries/mutations/account";
import {
  type IssuedTwoFactor,
  useDisableTwoFactor,
  useEnableTwoFactor,
  useRegenerateBackupCodes,
  useVerifyTwoFactorEnrolment,
} from "~/lib/queries/mutations/two-factor";

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
  // Ordered so the compiler can narrow rather than being told to. The old first
  // line handled both-null and the second then asserted `platform` non-null —
  // true, and unprovable from where it stood.
  if (browser === null) return platform ?? "Unknown device";
  if (platform === null) return browser;
  return `${browser} on ${platform}`;
}

// With the year, unlike the drop dates elsewhere: a forgotten session is
// exactly the row that is old enough for "12 Mar" to be ambiguous.
const SIGNED_IN: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
};

function ProfileCard({ me }: { me: Me }) {
  const rename = useUpdateName();
  const form = useAppForm({
    defaultValues: { name: me.user.name },
    onSubmit: ({ value }) => rename.mutate(value.name),
  });
  const [changingEmail, setChangingEmail] = useState(false);
  const emailForm = useAppForm({
    defaultValues: { newEmail: "" },
    onSubmit: ({ value }) => changeEmail.mutate(value.newEmail),
  });
  const changeEmail = useChangeEmail({
    onRequested: () => {
      setChangingEmail(false);
      emailForm.reset();
    },
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
          <Badge variant={me.user.emailVerified ? "outline" : "secondary"}>
            {me.user.emailVerified ? "verified" : "unverified"}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => setChangingEmail(!changingEmail)}>
            Change email
          </Button>
        </div>
        {changingEmail ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void emailForm.handleSubmit();
            }}
          >
            <emailForm.AppField
              name="newEmail"
              validators={{ onChange: changeEmailInput.shape.newEmail }}
            >
              {(field) => (
                <field.TextField
                  label="New email"
                  type="email"
                  autoComplete="email"
                  className="w-64"
                  description={
                    me.user.emailVerified
                      ? "Your current address approves the change, then the new one verifies itself. Sign-in moves with it; invitations sent to the old address stop being yours."
                      : "The address changes at once and the new one gets the verification mail. Sign-in moves with it; invitations sent to the old address stop being yours."
                  }
                />
              )}
            </emailForm.AppField>
            <emailForm.AppForm>
              <emailForm.SubmitButton pending={changeEmail.isPending}>
                Request change
              </emailForm.SubmitButton>
            </emailForm.AppForm>
          </form>
        ) : null}
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

// One password field, three verbs — enable, disable, regenerate — all guarded
// server-side by the same password, so the form is the same shape each time.
function PasswordGate({
  label,
  pending,
  destructive = false,
  onSubmit,
}: {
  label: string;
  pending: boolean;
  destructive?: boolean;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(password);
        setPassword("");
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={`gate-${label}`}>Your password</Label>
        <Input
          id={`gate-${label}`}
          type="password"
          autoComplete="current-password"
          className="w-56"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        variant={destructive ? "ghost" : "outline"}
        className={destructive ? "text-destructive" : undefined}
        disabled={password.length === 0 || pending}
      >
        {label}
      </Button>
    </form>
  );
}

// The backup codes, shown exactly once — the same "this is the only copy"
// treatment the provisioned connection string gets, because it is the same
// fact: the server stores them encrypted and cannot show them again.
function BackupCodesOnce({ codes, onSaved }: { codes: readonly string[]; onSaved: () => void }) {
  return (
    <div className="space-y-3 rounded-md border p-4">
      <p className="text-sm">
        <strong>Backup codes</strong> — each signs you in once if the authenticator is gone. This is
        the only time they are shown; the server keeps them encrypted and cannot display them again.
      </p>
      <div className="grid max-w-xs grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((code) => (
          <code key={code}>{code}</code>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigator.clipboard.writeText(codes.join("\n"))}
        >
          Copy all
        </Button>
        <Button size="sm" onClick={onSaved}>
          I saved them
        </Button>
      </div>
    </div>
  );
}

function TwoFactorCard({ me, accounts }: { me: Me; accounts: readonly ProviderAccount[] }) {
  // The one-time material lives here and only here: a QR to scan while
  // enrolling, and codes to save. Neither touches the query cache.
  const [issued, setIssued] = useState<IssuedTwoFactor | null>(null);
  const [savedCodes, setSavedCodes] = useState<readonly string[] | null>(null);
  const [verifyCode, setVerifyCode] = useState("");

  const enable = useEnableTwoFactor({ onIssued: setIssued });
  const verify = useVerifyTwoFactorEnrolment({
    onVerified: () => {
      setSavedCodes(issued?.backupCodes ?? null);
      setIssued(null);
      setVerifyCode("");
    },
  });
  const disable = useDisableTwoFactor({ onDone: () => setSavedCodes(null) });
  const regenerate = useRegenerateBackupCodes({ onIssued: setSavedCodes });

  const hasPassword = accounts.some((account) => account.providerId === "credential");
  const enabled = me.user.twoFactorEnabled === true;
  // The manual half of the QR, for the reader whose phone cannot scan it.
  const secret = issued === null ? null : new URL(issued.totpURI).searchParams.get("secret");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Two-factor authentication{" "}
          {enabled ? <Badge variant="outline">on</Badge> : <Badge variant="secondary">off</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasPassword ? (
          <p className="text-muted-foreground text-sm">
            You sign in with GitHub, which enforces its own second factor — there is no password
            here to pair a code with.
          </p>
        ) : savedCodes !== null ? (
          <BackupCodesOnce codes={savedCodes} onSaved={() => setSavedCodes(null)} />
        ) : issued !== null ? (
          <div className="space-y-4">
            <p className="text-sm">
              Scan this with your authenticator app, then enter the six digits it shows to turn
              two-factor on. Nothing is on until a code verifies.
            </p>
            <div className="w-fit rounded-md bg-white p-3">
              <QRCode value={issued.totpURI} size={168} aria-label="TOTP enrolment QR code" />
            </div>
            {secret !== null ? (
              <p className="text-muted-foreground text-sm">
                Can't scan it? Enter this key by hand:{" "}
                <code className="break-all font-mono text-xs">{secret}</code>
              </p>
            ) : null}
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                verify.mutate(verifyCode);
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="totp-verify">Authenticator code</Label>
                <Input
                  id="totp-verify"
                  autoComplete="one-time-code"
                  className="w-40"
                  value={verifyCode}
                  onChange={(event) => setVerifyCode(event.target.value)}
                />
              </div>
              <Button type="submit" disabled={verifyCode.length === 0 || verify.isPending}>
                Verify
              </Button>
              <Button type="button" variant="ghost" onClick={() => setIssued(null)}>
                Cancel
              </Button>
            </form>
          </div>
        ) : enabled ? (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Signing in asks for a code from your authenticator app. If you cannot reach it, the
              sign-in page can email a code to this address instead, or take one of your backup
              codes — regenerate those if they are running low or the sheet is gone. Lost the app
              and the codes, on a deployment that sends no email? Whoever runs this install can
              reset two-factor after verifying it is you; there is no self-serve way around it, on
              purpose.
            </p>
            <PasswordGate
              label="Regenerate backup codes"
              pending={regenerate.isPending}
              onSubmit={(password) => regenerate.mutate(password)}
            />
            <Separator />
            <PasswordGate
              label="Turn off two-factor"
              destructive
              pending={disable.isPending}
              onSubmit={(password) => disable.mutate(password)}
            />
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              A code from your phone alongside the password. Owner accounts decide what the engine
              may do to production databases — some installs require this before an owner can change
              anything.
            </p>
            <PasswordGate
              label="Enable two-factor"
              pending={enable.isPending}
              onSubmit={(password) => enable.mutate(password)}
            />
          </div>
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
    return (millisOf(b.updatedAt) ?? 0) - (millisOf(a.updatedAt) ?? 0);
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
                signed in{" "}
                <LocalTime
                  iso={
                    session.createdAt instanceof Date
                      ? session.createdAt.toISOString()
                      : session.createdAt
                  }
                  options={SIGNED_IN}
                  dateOnly
                />
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
      <TwoFactorCard me={me} accounts={accounts} />
      <SessionsCard sessions={sessions} currentToken={me.session.token} />
    </div>
  );
}
