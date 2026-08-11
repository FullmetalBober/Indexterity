import type { PrivilegeCheck } from "@repo/contracts";

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
