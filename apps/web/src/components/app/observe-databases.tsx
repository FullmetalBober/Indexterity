// Which of a cluster's databases Indexterity looks at (#244).
//
// One component, two screens: the connect form picks a selection before anything
// is stored, and the cluster's settings page edits it afterwards. Both are the
// same question asked of the same list, so a second copy of these boxes would be
// a second set of rules about what "all of them" means.
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";

// Nothing to choose between, so nothing is asked. A one-database cluster is the
// common case and the boxes would be a decision with one option — and worse, they
// would imply that the single box could be unticked, which the api refuses.
export const MIN_DATABASES_TO_CHOOSE = 2;

export interface ObserveDatabasesProps {
  // Every database the cluster reports. The full list even when the selection is
  // narrower, because a database that is not drawn can never be re-ticked.
  readonly available: readonly string[];
  // Which are ticked, or null for "all of them" — the same null the api stores,
  // so a cluster observing everything is not a list that happens to be complete.
  // The distinction survives a database being added: null keeps observing it, a
  // complete list does not.
  readonly selected: readonly string[] | null;
  readonly onChange: (selected: readonly string[] | null) => void;
  readonly disabled?: boolean;
  // Distinguishes the two screens where the sentence under the legend has to say
  // something different: on connect, nothing has been collected yet.
  readonly context: "connect" | "settings";
}

// True when this selection observes everything the cluster has. Both spellings
// count — null, and a list naming every database — because a reader who ticks
// the last box has said the same thing as one who never untuck any.
export function observesEverything(
  available: readonly string[],
  selected: readonly string[] | null,
): boolean {
  return selected === null || available.every((name) => selected.includes(name));
}

export function ObserveDatabases({
  available,
  selected,
  onChange,
  disabled = false,
  context,
}: ObserveDatabasesProps) {
  if (available.length < MIN_DATABASES_TO_CHOOSE) return null;
  const ticked = (name: string) => selected === null || selected.includes(name);
  const count = selected === null ? available.length : selected.length;

  // Ticking the last box hands back null rather than the complete list, so a
  // cluster the reader has re-widened observes databases added later too — which
  // is what "all of them" has to mean for it to be worth choosing over a list.
  function toggle(name: string, on: boolean) {
    const base = selected === null ? available : selected;
    const next = on ? [...base, name] : base.filter((entry) => entry !== name);
    onChange(available.every((entry) => next.includes(entry)) ? null : next);
  }

  return (
    <fieldset className="space-y-2">
      <legend className="font-medium text-sm">
        Databases to observe{" "}
        <span className="font-normal text-muted-foreground">
          — {count} of {available.length}
        </span>
      </legend>
      <p className="text-muted-foreground text-xs">
        {context === "connect"
          ? "Indexterity walks every collection in each database it observes. Untick the ones it should leave alone — staging copies, per-tenant clones, a restore."
          : "Unticking a database stops the next collect from walking it. What has already been measured is kept, and open proposals for it are discarded."}
      </p>
      <div className="grid gap-1.5">
        {available.map((name) => (
          <div key={name} className="flex items-center gap-2">
            <Checkbox
              id={`observe-${name}`}
              checked={ticked(name)}
              disabled={disabled}
              onCheckedChange={(checked) => toggle(name, checked === true)}
            />
            <Label htmlFor={`observe-${name}`} className="font-mono font-normal text-sm">
              {name}
            </Label>
          </div>
        ))}
      </div>
      {/* The api refuses an empty selection, and says so; this is the same rule
          stated in front of the reader instead of after the click. A cluster
          observing nothing is indistinguishable from a broken one on every panel
          afterwards, which is why "none" is not offered as a way to pause. */}
      {count === 0 ? (
        <p className="text-destructive text-xs">
          Pick at least one database — a cluster with none is not observed at all. Disconnect it
          instead if that is what you meant.
        </p>
      ) : null}
    </fieldset>
  );
}
