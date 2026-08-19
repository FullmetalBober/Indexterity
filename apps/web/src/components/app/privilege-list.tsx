import type { PrivilegeCheck } from "@repo/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";

// The statements that close a gap, ready to run (#246).
//
// Rendered rather than described: the Query Store row used to end in an ellipsis the
// reader had to expand once per database, having first worked out which databases
// were missing it. Only ever drawn for a check that is NOT granted, because the api
// only fills `command` for those.
//
// `pre` and not a paragraph: this is meant to be selected, and one ALTER DATABASE
// per line is how it will be pasted into a query window. No syntax colouring — it is
// three lines at most in practice, and a highlighter is a dependency plus a second
// way for this to be wrong about somebody's dialect.
function FixCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const lines = command.split("\n").length;
  return (
    <div className="mt-1 grid gap-1">
      <pre className="overflow-x-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
        {command}
      </pre>
      <div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            // No error branch. A clipboard write can be refused (an insecure origin,
            // a denied permission) and the statements are on the screen either way —
            // "Copied" not appearing is the whole message that needs sending.
            void navigator.clipboard
              .writeText(command)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
        >
          {copied ? "Copied" : lines === 1 ? "Copy" : `Copy all ${lines}`}
        </Button>
      </div>
    </div>
  );
}

function Row({ privilege, optional }: { privilege: PrivilegeCheck; optional: boolean }) {
  // An ungranted requirement is a fault in the connection; an ungranted optional
  // action is a path that is not available. Different marks, because red is a
  // claim that something is wrong.
  const mark = privilege.granted ? "✓" : optional ? "–" : "✗";
  return (
    <li className="flex gap-2">
      <span
        className={
          privilege.granted ? "text-primary" : optional ? "text-muted-foreground" : "text-red-600"
        }
      >
        {mark}
      </span>
      <span className={privilege.granted || optional ? "" : "font-medium"}>
        {privilege.label}
        {privilege.granted ? null : (
          <span className="font-normal text-muted-foreground"> — {privilege.enables}</span>
        )}
        {/* `== null`, not `=== null`, and that is the whole point of the loose
            comparison: an api that predates this field sends no `command` key at
            all, so the value arrives as undefined and a strict check let it
            through — straight into `command.split`, which is a blank error screen
            instead of a privilege list. Reachable in dev the moment the web
            reloads and the api has not, and in prod for the length of a rolling
            deploy, so the consumer tolerates the older shape rather than assuming
            both sides moved together. An empty string is treated the same way:
            nothing to run is nothing to draw. */}
        {privilege.command == null || privilege.command === "" ? null : (
          <FixCommand command={privilege.command} />
        )}
      </span>
    </li>
  );
}

// What the engine needs, and then — under a line of its own — what it would take
// for Indexterity to create its own scoped user instead.
//
// The second group used to not be drawn at all: provisioning was one boolean on
// the diagnosis, and when it came back false the form went quiet, so a user that
// cannot create users looked exactly like a diagnosis that could not tell (#86).
// It is a separate group rather than three more rows in the first because a
// missing `createUser` is not a fault in the connection — mixed in with a missing
// $indexStats it would read as "this cluster cannot be analyzed".
export function PrivilegeList({ privileges }: { privileges: readonly PrivilegeCheck[] }) {
  const engine = privileges.filter((privilege) => privilege.tier !== "PROVISION");
  const provisioning = privileges.filter((privilege) => privilege.tier === "PROVISION");
  return (
    <>
      <ul className="mt-2 space-y-0.5 text-xs">
        {engine.map((privilege) => (
          <Row key={privilege.key} privilege={privilege} optional={false} />
        ))}
      </ul>
      {provisioning.length > 0 ? (
        <>
          <p className="mt-2 text-muted-foreground text-xs">
            To create a scoped user instead of using these credentials:
          </p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {provisioning.map((privilege) => (
              <Row key={privilege.key} privilege={privilege} optional={true} />
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
