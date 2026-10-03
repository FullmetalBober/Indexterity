import { type Document, MongoServerError } from "mongodb";
import type { DatabaseWatch, FailureWatch, WatchTarget } from "../engine/ports";
import { messageOf } from "../errors/message";
import type { MongoConnection } from "./connection";
import { isAuthorizationError } from "./errors";
import { type MemberConnections, profiledNodes } from "./members";
import { markerOf, planWatch, profilerSettingsOn, type WatchMarker, watchFilter } from "./profiler";

// One node's part in one database's watch.
type NodeOutcome =
  | {
      readonly kind: "WATCHED";
      readonly since: ReadonlyMap<string, number>;
      readonly ours: boolean;
    }
  | { readonly kind: "UNWATCHED"; readonly reason: string; readonly ours: boolean };

interface ProfiledNode {
  readonly host: string;
  readonly conn: MongoConnection;
}

// Keeps the profiler on for the drops in flight, node by node (#596). Every
// decision is planWatch's (mongo/profiler.ts); this only reads each node's
// settings, carries out the step, and adds the nodes up.
export class MongoFailureWatch implements FailureWatch {
  constructor(
    private readonly conn: MongoConnection,
    private readonly members: MemberConnections,
    private readonly now: () => number = Date.now,
  ) {}

  async reconcile(
    owner: string,
    targets: readonly WatchTarget[],
    release: readonly string[],
  ): Promise<ReadonlyMap<string, DatabaseWatch>> {
    const wanted = byDatabase(targets);
    const databases = [...new Set([...wanted.keys(), ...release])];
    const out = new Map<string, DatabaseWatch>();
    if (databases.length === 0) return out;
    // The profiler is set on each shard's own nodes, and mongos refuses it:
    // `profile: 1` through mongos answered BadValue "Profiling is not permitted on
    // mongoS" on 7.0. Indexterity reaches a sharded cluster through mongos alone,
    // so there is nothing here it can turn on — and nothing it can have turned on
    // to give back.
    if ((await this.conn.helloNode())?.role === "mongos") {
      for (const database of databases) {
        out.set(
          database,
          wanted.has(database)
            ? {
                kind: "UNWATCHED",
                reason: `the profiler is set on each shard, and Indexterity reaches ${database} through mongos`,
                ours: false,
              }
            : { kind: "RELEASED", ours: false },
        );
      }
      return out;
    }
    const nodes = await profiledNodes(this.conn, this.members);
    for (const database of databases) {
      const want = wanted.get(database) ?? new Map<string, readonly string[]>();
      // Key patterns are read once per database, and only when a step needs them.
      let keys: Promise<ReadonlyMap<string, Document>> | null = null;
      const patterns = () => {
        keys ??= this.keyPatterns(database, want);
        return keys;
      };
      const outcomes: { host: string; outcome: NodeOutcome }[] = [];
      for (const node of nodes) {
        outcomes.push({
          host: node.host,
          outcome: await this.step(node, owner, database, want, patterns),
        });
      }
      out.set(database, combine(want, outcomes));
    }
    return out;
  }

  private async step(
    node: ProfiledNode,
    owner: string,
    database: string,
    wanted: ReadonlyMap<string, readonly string[]>,
    patterns: () => Promise<ReadonlyMap<string, Document>>,
  ): Promise<NodeOutcome> {
    const settings = await profilerSettingsOn(node.conn, database);
    if (settings === null) {
      return {
        kind: "UNWATCHED",
        reason: `the profiler's settings on ${database} could not be read`,
        ours: false,
      };
    }
    const marker = markerOf(settings.filter);
    const ours = marker !== null && marker.owner === owner;
    const step = planWatch({ database, owner, settings, wanted, now: this.now() });
    switch (step.kind) {
      case "KEEP":
        // Kept as ours means up to date; kept otherwise, with something wanted,
        // means the profiler records every operation already — complete for as
        // long as its ring reaches, so no start of our own to wait out.
        return {
          kind: "WATCHED",
          since:
            ours && settings.was === 1 && marker !== null
              ? sinceOf(marker)
              : new Map([...wanted.keys()].map((ns) => [ns, 0])),
          ours,
        };
      case "SET":
        try {
          await node.conn
            .db(database)
            .command({ profile: 1, filter: watchFilter(step.marker, await patterns()) });
          return { kind: "WATCHED", since: sinceOf(step.marker), ours: true };
        } catch (error) {
          return { kind: "UNWATCHED", reason: refusal(database, error), ours };
        }
      case "RESTORE":
        try {
          await node.conn.db(database).command({ profile: step.level, filter: step.filter });
          return { kind: "UNWATCHED", reason: "", ours: false };
        } catch (error) {
          return {
            kind: "UNWATCHED",
            reason: `the profiler on ${database} could not be given back (${messageOf(error)})`,
            ours: true,
          };
        }
      case "DECLINE":
        return { kind: "UNWATCHED", reason: step.reason, ours };
    }
  }

  // "ns\0name" -> the index's key pattern, for the hints that name an index by
  // its pattern. Read on the base connection: index definitions replicate.
  private async keyPatterns(
    database: string,
    wanted: ReadonlyMap<string, readonly string[]>,
  ): Promise<ReadonlyMap<string, Document>> {
    const out = new Map<string, Document>();
    for (const [ns, names] of wanted) {
      if (names.length === 0) continue;
      const collection = ns.slice(database.length + 1);
      const specs = await this.conn
        .db(database)
        .collection(collection)
        .listIndexes()
        .toArray()
        .catch(() => []);
      for (const spec of specs) {
        const name: unknown = spec.name;
        const key: unknown = spec.key;
        if (typeof name === "string" && names.includes(name) && isDocument(key)) {
          out.set(`${ns}\u0000${name}`, key);
        }
      }
    }
    return out;
  }
}

function isDocument(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// database -> namespace -> the indexes whose hint() to record there.
function byDatabase(targets: readonly WatchTarget[]): Map<string, Map<string, readonly string[]>> {
  const out = new Map<string, Map<string, readonly string[]>>();
  for (const target of targets) {
    const namespaces = out.get(target.database) ?? new Map<string, readonly string[]>();
    const ns = `${target.database}.${target.collection}`;
    const hints = namespaces.get(ns) ?? [];
    namespaces.set(ns, target.beforeHide ? [...hints, target.indexName] : hints);
    out.set(target.database, namespaces);
  }
  return out;
}

function sinceOf(marker: WatchMarker): ReadonlyMap<string, number> {
  return new Map(Object.entries(marker.watch));
}

// Why turning the profiler on was refused, in the words an owner acts on.
function refusal(database: string, error: unknown): string {
  if (isAuthorizationError(error)) {
    return `Indexterity's user may not turn the profiler on for ${database} (it needs the enableProfiler action)`;
  }
  // Atlas's shared tiers answer an unsupported command with code 8000.
  if (
    error instanceof MongoServerError &&
    (error.code === 8000 || /CMD_NOT_ALLOWED/.test(error.message))
  ) {
    return `this deployment does not allow the profile command, so the profiler on ${database} cannot be turned on`;
  }
  return `the profiler on ${database} could not be turned on (${messageOf(error)})`;
}

// Every node's outcome as the database's. Watched only if every node is — a
// member left out is reads left out — and from the latest start among them; the
// same reason from every node is said once.
function combine(
  wanted: ReadonlyMap<string, readonly string[]>,
  outcomes: readonly { host: string; outcome: NodeOutcome }[],
): DatabaseWatch {
  const ours = outcomes.some(({ outcome }) => outcome.ours);
  if (wanted.size === 0) return { kind: "RELEASED", ours };
  const refused = outcomes.flatMap(({ host, outcome }) =>
    outcome.kind === "UNWATCHED" ? [{ host, reason: outcome.reason }] : [],
  );
  if (refused.length > 0) {
    const distinct = [...new Set(refused.map((entry) => entry.reason))];
    const [first] = distinct;
    return {
      kind: "UNWATCHED",
      reason:
        distinct.length === 1 && first !== undefined && refused.length === outcomes.length
          ? first
          : refused.map((entry) => `on ${entry.host}, ${entry.reason}`).join("; "),
      ours,
    };
  }
  const since = new Map<string, number>();
  for (const { outcome } of outcomes) {
    if (outcome.kind !== "WATCHED") continue;
    for (const ns of wanted.keys()) {
      since.set(ns, Math.max(since.get(ns) ?? 0, outcome.since.get(ns) ?? 0));
    }
  }
  return { kind: "WATCHED", since, ours };
}
