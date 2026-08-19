import {
  type ClusterEngine,
  type ConnectionDiagnosis,
  createClusterInput,
  engineFromScheme,
  NO_TLS_OVERRIDES,
  type PlanInfo,
  type SupportedEngine,
  type TlsOverrides,
} from "@repo/contracts";
import { useState } from "react";
import { usage } from "~/components/app/format";
import {
  MIN_DATABASES_TO_CHOOSE,
  ObserveDatabases,
  observesEverything,
} from "~/components/app/observe-databases";
import { PrivilegeList } from "~/components/app/privilege-list";
import { useAppForm } from "~/components/form";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  useCheckConnection,
  useConnectCluster,
  useProvisionCluster,
} from "~/lib/queries/mutations/cluster";
import { useEngines } from "~/lib/queries/shell";
import { CLUSTER_USER_DOCS_HREF } from "~/lib/site";

// The api's own rules for these two fields, so a string it will refuse for being
// empty is refused here by the same schema rather than by a second copy of it.
const NAME = createClusterInput.shape.name;
const CONNECTION_STRING = createClusterInput.shape.connectionString;

// One entry per driver option, spelled out rather than summarised: the reader is
// being asked to give up a specific protection, so the help text says which.
const TLS_BOXES: readonly { key: keyof TlsOverrides; label: string; help: string }[] = [
  {
    key: "allowInvalidCertificates",
    label: "Allow an unverified certificate",
    help: "Self-signed, or signed by a certificate authority we do not carry. The connection is still encrypted; nothing proves who is on the other end.",
  },
  {
    key: "allowInvalidHostnames",
    label: "Allow a mismatched hostname",
    help: "The certificate is valid but issued for a different name than the one being dialed — usual with an SSH tunnel or a rewritten DNS name.",
  },
  {
    key: "insecure",
    label: "Skip every certificate check",
    help: "The broadest of the three: both of the above, plus expired certificates and no revocation check. Prefer one of the narrower boxes if it is enough.",
  },
];

// What each engine is CALLED, which is the one thing about an engine the api
// does not answer for: `supportedEngines` returns the enum value and the string
// forms it takes, and "MSSQL" is a wire constant rather than a name to show a
// reader. POSTGRESQL is here for the release its adapter lands (#35) — the list
// on screen is whatever the api says it supports, so this map is allowed to know
// about an engine before the build does.
const ENGINE_LABEL: Record<ClusterEngine, string> = {
  MONGODB: "MongoDB",
  MSSQL: "SQL Server",
  POSTGRESQL: "PostgreSQL",
};

// A placeholder for each dialect, so the field itself stops implying that
// MongoDB is all this takes (#239). Shortened from the api's own hints, which
// are complete and too long to sit inside an input — the hints are printed in
// full under the field, where they have the room.
const PLACEHOLDER = "mongodb://user:pass@host:27017   or   Server=host;User Id=sa;Password=…";

// What the scoped user IS, per engine — the offer is engine-neutral (it hangs
// off `canProvision`), the words cannot be: "no read access to your documents"
// and `db.dropUser` are the wrong sentence entirely in front of a SQL Server.
const SCOPED_USER_COPY = {
  MONGODB: {
    subject: "user",
    grant: (
      <>
        with the <code>indexterityEngine</code> role
      </>
    ),
    withheld: "no read access to your documents",
    revoke: <code>db.dropUser(…)</code>,
  },
  MSSQL: {
    subject: "login",
    grant: (
      <>
        granted <code>VIEW SERVER STATE</code>, <code>VIEW DATABASE STATE</code> and{" "}
        <code>ALTER</code> on each schema that holds tables
      </>
    ),
    withheld: "no permission to read a single row of your data",
    revoke: <code>DROP LOGIN idx_…</code>,
  },
} as const;

// Takes the RESOLVED engine rather than the string it came from. It used to read
// the string through a second copy of the scheme rules, which is the pair that
// drifts: the api's guards moved and this regex would not have. Now one hint
// function decides (engineFromScheme in @repo/contracts), the api's diagnosis
// overrules it the moment there is one, and both arrive here as an engine.
//
// PostgreSQL has no entry because it has no adapter and so can never be
// provisioned; falling back to the MongoDB paragraph would be a promise about a
// shell command that does not apply, so the caller is expected to have a
// supported engine by the time it asks.
function scopedUserCopy(engine: ClusterEngine) {
  return engine === "MSSQL" ? SCOPED_USER_COPY.MSSQL : SCOPED_USER_COPY.MONGODB;
}

// What the typed string looks like, as one primitive so the component re-renders
// only when the ANSWER changes rather than on every keystroke — the form store
// deliberately does not re-render this component per character, and a mirror of
// the string in React state would have undone that.
//
//   null        nothing typed yet, so nothing to say
//   "UNKNOWN"   something is typed and no engine's scheme claims it — the only
//               state the override belongs in
//   an engine   the scheme says which, subject to the api's verdict
type EngineHint = ClusterEngine | "UNKNOWN" | null;

function hintFor(connectionString: string): EngineHint {
  if (connectionString.trim().length === 0) return null;
  return engineFromScheme(connectionString) ?? "UNKNOWN";
}

// The forms of connection string this build takes, printed before anything is
// pasted (#239). Nothing on this screen used to say SQL Server was supported at
// all — the placeholder said `mongodb://` and the helper text said "any
// connection string", so a SQL Server owner read the form as a no.
//
// Read from the api rather than written out here, because the list is a property
// of the deployed build: PostgreSQL appears the release its adapter lands and a
// sentence in this file would have been wrong in both directions — claiming it
// early, or omitting it after.
function AcceptedForms({ engines }: { engines: SupportedEngine[] }) {
  if (engines.length === 0) return null;
  return (
    <div className="text-muted-foreground text-xs">
      <span>{engines.length === 1 ? "Takes" : "Takes any of these:"}</span>
      <ul className="mt-1 grid gap-0.5">
        {engines.map((option) => (
          <li key={option.engine}>
            <span className="text-foreground">{ENGINE_LABEL[option.engine]}</span> —{" "}
            <code>{option.connStringHint}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Why no scoped user was offered, on a connection that is otherwise fine.
//
// Says which action is missing rather than that one is: `createUser` alone is a
// different grant from all three, and the reader is being asked to go and change
// a role on their own cluster. Silent in the one case where the answer is not
// about a grant at all — a deployment with authentication disabled has every
// privilege and still cannot enforce a dedicated user, and the diagnosis's own
// message says so.
function ProvisioningUnavailable({ diagnosis }: { diagnosis: ConnectionDiagnosis }) {
  const gaps = diagnosis.privileges.filter(
    (privilege) => privilege.tier === "PROVISION" && !privilege.granted,
  );
  if (!diagnosis.authEnabled || gaps.length === 0) return null;
  return (
    <p className="mt-3 text-muted-foreground text-xs">
      No scoped user was offered: these credentials are missing{" "}
      {gaps.map((gap, index) => (
        <span key={gap.key}>
          {index > 0 ? ", " : null}
          <code>{gap.key}</code>
        </span>
      ))}{" "}
      . Connecting as-is stores the string you pasted (encrypted) and dials the cluster with it on
      every collect. Grant {gaps.length === 1 ? "that one" : "those"} and check again, and
      Indexterity will offer to create an <code>idx_…</code> user with only the privileges above
      instead — or create one yourself and connect with its string.{" "}
      <a href={CLUSTER_USER_DOCS_HREF} className="underline">
        The exact role is here
      </a>
      .
    </p>
  );
}

// The plan the clusters are counted against, or null while the org read has not
// arrived — in which case the quota simply is not drawn. It is a warning, not a
// gate: the api is the one that refuses, and it refuses on the same numbers.
export function ConnectClusterForm({ plan }: { plan: PlanInfo | null }) {
  const [error, setError] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<ConnectionDiagnosis | null>(null);
  // The engine travels with the credentials, and it has to: this alert survives
  // the connect that clears the diagnosis, and it prints the command that revokes
  // the login again afterwards — which is `db.dropUser` on one engine and `DROP
  // LOGIN` on the other. Before #239 it printed the Mongo one either way, so a
  // SQL Server owner was handed a shell command their server has never heard of.
  const [provisioned, setProvisioned] = useState<{
    username: string;
    connectionString: string;
    engine: ClusterEngine;
  } | null>(null);
  // Which certificate checks the reader is choosing to skip. Outside the form
  // store deliberately: they are not validated fields, and the two buttons under
  // a diagnosis read them at click time the same way the credentials are read.
  const [tls, setTls] = useState<TlsOverrides>(NO_TLS_OVERRIDES);
  // What the typed string looks like, and — only when it looks like nothing —
  // which engine the reader said it is.
  const [hint, setHint] = useState<EngineHint>(null);
  const [chosen, setChosen] = useState<ClusterEngine | null>(null);
  // Which databases to observe (#244), or null for all of them — which is what it
  // is until somebody unticks a box, and what a one-database cluster stays.
  //
  // Outside the form store for the same reason the certificate boxes are: it is
  // not a validated field, and the buttons under the diagnosis read it at click
  // time. Reset by onConnected along with everything else, because the next
  // cluster's databases are not this one's.
  const [observed, setObserved] = useState<readonly string[] | null>(null);
  // The scope the diagnosis on screen was computed for, so a selection changed
  // afterwards can be told apart from one the api already answered about.
  const [diagnosedScope, setDiagnosedScope] = useState<readonly string[] | null>(null);
  const engines = useEngines();

  // Every path starts by clearing what the last one said, so a stale error
  // cannot sit above a fresh answer.
  function onStart() {
    setError(null);
  }

  // A connect succeeded: empty the form, but keep any provisioned string, which
  // is the only copy the reader will ever see.
  function onConnected() {
    form.reset();
    setDiagnosis(null);
    setTls(NO_TLS_OVERRIDES);
    setHint(null);
    setChosen(null);
    setObserved(null);
  }

  const check = useCheckConnection({
    onStart: () => {
      onStart();
      setDiagnosis(null);
      setProvisioned(null);
    },
    onDiagnosis: (diagnosis, scope) => {
      setDiagnosis(diagnosis);
      setDiagnosedScope(scope);
    },
    onError: setError,
  });

  const connectAsIs = useConnectCluster({ onStart, onConnected, onError: setError });

  const provision = useProvisionCluster({
    onStart,
    onConnected,
    onError: setError,
    onProvisioned: setProvisioned,
  });

  const form = useAppForm({
    defaultValues: { name: "", connectionString: "" },
    // Submitting is the preflight, not the connect: nothing is stored until the
    // reader has seen what the string can do and picked one of the answers below.
    onSubmit: ({ value }) =>
      check.mutate({
        connectionString: value.connectionString,
        tlsOverrides: tls,
        engine: engineOverride(),
      }),
  });

  // The engine to SEND, which is almost always none: the api reads the string,
  // and only a string no scheme claims needs the reader to say. Derived at call
  // time from the current hint rather than remembered, so a reader who picked an
  // engine and then fixed their string cannot have that stale pick override the
  // api's own detection.
  function engineOverride(): ClusterEngine | undefined {
    return hint === "UNKNOWN" && chosen !== null ? chosen : undefined;
  }

  // Which engine to SAY, which is a different question: the api's verdict when
  // there is one, the scheme's guess while the reader is still typing, and the
  // override in the gap where neither has an answer. Null draws no badge at all —
  // better silent than confidently wrong about somebody's cluster.
  const shown: ClusterEngine | null =
    diagnosis?.engine ?? (hint === "UNKNOWN" ? chosen : hint) ?? null;

  // One flag over three mutations: any of them in flight means the form is
  // waiting on the api, and the second click would be about stale fields.
  const busy = check.isPending || connectAsIs.isPending || provision.isPending;

  // Read at click time rather than at render: the two buttons under a diagnosis
  // are not the form's submit, and the form store deliberately does not re-render
  // this component when a field changes.
  const credentials = () => ({
    ...form.state.values,
    tlsOverrides: tls,
    engine: engineOverride(),
    // Absent when everything is observed, rather than a list of every name: the
    // api stores null for that, and null is what keeps a database added next month
    // observed as well.
    observedDatabases: observed === null ? undefined : [...observed],
  });

  // Whether the answer on screen was computed for the databases now ticked. Both
  // spellings of "all of them" count as the same scope, or ticking the last box
  // back would ask the reader to re-check for an answer they already have.
  function scopeMatchesDiagnosis(): boolean {
    const asked = diagnosedScope;
    const now = observed;
    if (asked === null || now === null) {
      return (
        (asked === null ||
          (diagnosis !== null && observesEverything(diagnosis.databases, asked))) &&
        (now === null || (diagnosis !== null && observesEverything(diagnosis.databases, now)))
      );
    }
    return asked.length === now.length && asked.every((name) => now.includes(name));
  }

  // Ask again for the databases now ticked. The one path that re-checks with a
  // scope: the first check cannot, because the list it would choose from is what
  // it returns.
  function recheck() {
    check.mutate({
      connectionString: form.state.values.connectionString,
      tlsOverrides: tls,
      engine: engineOverride(),
      observedDatabases: observed === null ? undefined : [...observed],
    });
  }

  // A diagnosis describes one exact string, and the boxes are part of the string
  // that gets checked — so moving one invalidates the answer above exactly the
  // way editing the connection string does.
  function setOverride(key: keyof TlsOverrides, value: boolean) {
    setTls((current) => ({ ...current, [key]: value }));
    setDiagnosis(null);
  }

  // Same rule as the boxes above, for the same reason: the engine is part of what
  // was asked, so choosing another one makes the answer on screen an answer to a
  // different question.
  function chooseEngine(engine: ClusterEngine) {
    setChosen(engine);
    setDiagnosis(null);
  }

  // The meter this form spends, read before a word is typed. Unlimited plans
  // have a null cap and can never be full.
  const full = plan !== null && plan.maxClusters !== null && plan.clustersUsed >= plan.maxClusters;

  return (
    <Card className="mt-8">
      {/* No title of its own: the page this sits on is called "Connect a
          cluster" and there is nothing else on it, so a card repeating the
          heading is a second heading for one thing. */}
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardDescription>
            Paste any connection string — Indexterity checks what it can do before storing anything.
            Clusters start in read-only mode.
          </CardDescription>
          {/* The count belongs beside the form that spends it, not on the org
              page: a limit nobody sees until it refuses them is a 402 in the
              middle of someone's work. */}
          {plan !== null ? (
            <span
              className={
                full
                  ? "shrink-0 text-destructive text-xs"
                  : "shrink-0 text-muted-foreground text-xs"
              }
            >
              {usage(plan.clustersUsed, plan.maxClusters)} clusters on the {plan.plan} plan
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {plan !== null && full ? (
          <Alert variant="destructive">
            <AlertTitle>No room for another cluster</AlertTitle>
            {/* Nothing is disabled below. Checking a string stores nothing and
                is still worth doing, and the api owns the refusal — a button
                greyed out by a stale count would be a lie either way. */}
            <AlertDescription>
              The {plan.plan} plan allows {plan.maxClusters}{" "}
              {plan.maxClusters === 1 ? "cluster" : "clusters"}. Checking a connection string still
              works, but connecting one will be refused until you disconnect a cluster or move to a
              plan with room for more.
            </AlertDescription>
          </Alert>
        ) : null}

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.AppField name="name" validators={{ onChange: NAME }}>
            {(field) => <field.TextField label="Name" className="w-48" placeholder="Production" />}
          </form.AppField>
          <form.AppField
            name="connectionString"
            validators={{ onChange: CONNECTION_STRING }}
            // A diagnosis describes one exact string. Edit the string and it
            // describes nothing — better no answer than last string's answer.
            //
            // The hint is recomputed here rather than subscribed to: this is the
            // one place the new value arrives, and setting a primitive React
            // already holds is a no-op, so typing inside one dialect re-renders
            // the card once (when the scheme first matches) instead of per key.
            listeners={{
              onChange: ({ value }) => {
                setDiagnosis(null);
                setHint(hintFor(value));
                // The selection was made from a list this string produced. Another
                // string is another cluster — keeping the names would submit a
                // choice about databases the new one may not have.
                setObserved(null);
              },
            }}
          >
            {(field) => (
              <field.TextField
                label="Connection string"
                className="font-mono"
                placeholder={PLACEHOLDER}
              />
            )}
          </form.AppField>
          <form.AppForm>
            <form.SubmitButton pending={busy}>
              {busy ? "Checking…" : "Check access"}
            </form.SubmitButton>
          </form.AppForm>
        </form>

        {/* What this build takes, and what it made of what was typed (#239).
            Above the certificate boxes because it answers an earlier question:
            whether this product handles your database at all. */}
        <div className="space-y-2">
          <AcceptedForms engines={engines} />

          {shown !== null ? (
            <p className="text-muted-foreground text-xs">
              Reading this as{" "}
              <Badge variant="secondary" className="font-normal">
                {ENGINE_LABEL[shown]}
              </Badge>{" "}
              {/* Two sources, and which one is talking matters: before the check
                  this is a guess off the scheme and the api may still disagree;
                  after it, it is the engine that will be stored. */}
              {diagnosis === null ? "— confirmed when you check access" : null}
            </p>
          ) : null}

          {/* Only when nothing claimed the string. A picker in front of the
              strings detection DOES recognise would be a way to be wrong: choose
              MongoDB, paste `Server=…`, and the api honours the choice and
              refuses a string it would otherwise have accepted. So this appears
              exactly where detection has nothing to offer — and if the reader
              then fixes the string, the pick stops being sent rather than
              overruling the engine the string now names. */}
          {hint === "UNKNOWN" && engines.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {/* The ask, until it has been answered. Leaving "if you know what
                  it is, say so" up after they said so contradicts the badge
                  directly above, which by then states the outcome — so the
                  sentence goes and the select stays, because changing the answer
                  is the only thing left to do here. */}
              <span className="text-muted-foreground">
                {chosen === null
                  ? "No engine recognises this string. If you know what it is, say so and Indexterity will try it — otherwise check the forms above."
                  : "Still unrecognised, so it will be tried as:"}
              </span>
              <Select
                value={chosen ?? ""}
                onValueChange={(value) => chooseEngine(value as ClusterEngine)}
              >
                <SelectTrigger className="h-8 w-44" aria-label="Which engine is this">
                  <SelectValue placeholder="Choose the engine" />
                </SelectTrigger>
                <SelectContent>
                  {engines.map((option) => (
                    <SelectItem key={option.engine} value={option.engine}>
                      {ENGINE_LABEL[option.engine]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        {/* Under the string, not beside it: these describe the connection the
            string makes, and each one gives up a check that TLS is otherwise
            there to perform. Refused outright unless ticked (mongo/client.ts),
            so this is the only way to connect a cluster whose certificate does
            not verify — and it stays visible on the cluster afterwards rather
            than being a decision made once and forgotten.

            Three boxes rather than one "insecure" toggle, because they are not
            the same concession: a private CA fails certificate validation with a
            perfectly correct hostname, and an SSH tunnel or a rewritten DNS name
            fails the hostname check with a genuinely valid certificate. One
            switch would make everyone give up both. */}
        <fieldset className="space-y-2">
          <legend className="font-medium text-sm">
            Certificate checks{" "}
            <span className="font-normal text-muted-foreground">
              — leave these alone unless the connection fails on the certificate
            </span>
          </legend>
          {TLS_BOXES.map((box) => (
            <div key={box.key} className="flex items-start gap-2">
              <Checkbox
                id={`tls-${box.key}`}
                checked={tls[box.key]}
                onCheckedChange={(checked) => setOverride(box.key, checked === true)}
                className="mt-0.5"
              />
              <div className="grid gap-0.5 leading-tight">
                <Label htmlFor={`tls-${box.key}`} className="font-normal text-sm">
                  {box.label}
                </Label>
                <p className="text-muted-foreground text-xs">{box.help}</p>
              </div>
            </div>
          ))}
        </fieldset>

        {error !== null ? (
          <Alert variant="destructive">
            <AlertTitle>Could not check the connection</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {diagnosis !== null && !diagnosis.reachable ? (
          <Alert variant="destructive">
            <AlertTitle>Cannot use this connection string</AlertTitle>
            <AlertDescription>{diagnosis.message}</AlertDescription>
          </Alert>
        ) : null}

        {diagnosis?.reachable === true ? (
          <div className="rounded-lg border p-4 text-sm">
            <p className="font-medium">
              Connected as{" "}
              <code>{diagnosis.username ?? (diagnosis.authEnabled ? "unknown" : "no auth")}</code>
            </p>
            {diagnosis.message !== null ? (
              <p className="mt-1 text-muted-foreground text-xs">{diagnosis.message}</p>
            ) : null}
            <PrivilegeList privileges={diagnosis.privileges} />

            {/* Under the privileges, not beside the connection string (#244).
                The list can only exist once the cluster has answered, and the
                choice belongs next to the verdict it changes: a role scoped to
                one database reads as a gap above while the whole cluster is in
                scope, and as a grant once it is not. */}
            {diagnosis.databases.length >= MIN_DATABASES_TO_CHOOSE ? (
              <div className="mt-3 border-t pt-3">
                <ObserveDatabases
                  available={diagnosis.databases}
                  selected={observed}
                  onChange={setObserved}
                  disabled={busy}
                  context="connect"
                />
                {/* Only when the verdict could actually change. A full grant says
                    the same thing about one database as about twelve, and asking
                    the reader to check again for an identical answer is a step
                    that teaches them to ignore this line. */}
                {diagnosis.missing.length > 0 && !scopeMatchesDiagnosis() ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground text-xs">
                      The privileges above were checked against{" "}
                      {diagnosedScope === null
                        ? "every database"
                        : `${diagnosedScope.length} of them`}
                      .
                    </span>
                    <Button size="sm" variant="outline" disabled={busy} onClick={recheck}>
                      {busy ? "Checking…" : "Check these instead"}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {diagnosis.missing.length > 0 ? (
              <Alert variant="destructive" className="mt-3">
                <AlertTitle>Missing: {diagnosis.missing.join(", ")}</AlertTitle>
                <AlertDescription>
                  {diagnosis.ready
                    ? "The cluster can still be analyzed, but no change can be applied."
                    : "Analysis is not possible without these."}
                </AlertDescription>
              </Alert>
            ) : null}

            {diagnosis.canProvision ? (
              <div className="mt-3 rounded-md bg-muted/40 p-3">
                <p className="font-medium">
                  These credentials can create {scopedUserCopy(diagnosis.engine).subject}s — let
                  Indexterity make its own?
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {(() => {
                    const copy = scopedUserCopy(diagnosis.engine);
                    return (
                      <>
                        A dedicated {copy.subject} <code>idx_…</code> is created on your cluster{" "}
                        {copy.grant}: exactly the privileges listed above and nothing else — notably{" "}
                        <strong>{copy.withheld}</strong>. The admin string you pasted is used once
                        and never stored; only the new {copy.subject}'s string is kept (encrypted).
                        Revoke it any time with {copy.revoke}.
                      </>
                    );
                  })()}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    disabled={busy}
                    onClick={() => {
                      const { name, connectionString, tlsOverrides } = credentials();
                      provision.mutate({
                        name,
                        adminConnectionString: connectionString,
                        tlsOverrides,
                        // The login this creates is granted per database on SQL
                        // Server, so the selection narrows what it may touch
                        // rather than only what we read.
                        observedDatabases: observed === null ? undefined : [...observed],
                      });
                    }}
                  >
                    {/* "user" or "login" — the same word the paragraph above
                        uses, because a button naming a thing SQL Server does not
                        have is the one piece of this offer a reader acts on. */}
                    {busy
                      ? "Creating…"
                      : `Create a scoped ${scopedUserCopy(diagnosis.engine).subject} and connect`}
                  </Button>
                  {diagnosis.ready ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => connectAsIs.mutate(credentials())}
                    >
                      Use these credentials as-is
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : diagnosis.ready ? (
              <>
                <Button
                  className="mt-3"
                  disabled={busy}
                  onClick={() => connectAsIs.mutate(credentials())}
                >
                  Connect
                </Button>
                {/* The branch that used to render a bare Connect button and
                    nothing else. "These credentials cannot create users" and "we
                    could not tell what they can do" were the same pixels, and
                    the safer path was never mentioned to the one reader who
                    could still take it (#86). */}
                <ProvisioningUnavailable diagnosis={diagnosis} />
              </>
            ) : (
              <p className="mt-2 text-muted-foreground text-xs">
                Grant the missing privileges to this user, or paste credentials that can create
                users and Indexterity will provision a scoped one for you.{" "}
                <a href={CLUSTER_USER_DOCS_HREF} className="underline">
                  The exact role is here
                </a>
                .
              </p>
            )}
          </div>
        ) : null}

        {provisioned !== null ? (
          <Alert>
            <AlertTitle>
              Created scoped {scopedUserCopy(provisioned.engine).subject}{" "}
              <code>{provisioned.username}</code> — shown once
            </AlertTitle>
            <AlertDescription className="grid gap-1">
              <code className="break-all font-mono text-xs">{provisioned.connectionString}</code>
              <span className="text-xs">
                Stored encrypted; the admin string was not saved. To revoke access later:{" "}
                {provisioned.engine === "MSSQL" ? (
                  <code>DROP LOGIN {provisioned.username}</code>
                ) : (
                  <code>db.dropUser("{provisioned.username}")</code>
                )}{" "}
                {provisioned.engine === "MSSQL" ? "on the server" : "in the admin database"}.
              </span>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
