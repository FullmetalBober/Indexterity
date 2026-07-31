export type IndexDirection = 1 | -1 | "2dsphere" | "text" | "hashed";

export interface IndexKey {
  readonly field: string;
  readonly direction: IndexDirection;
}

// Normalized view of a MongoDB index plus the options that affect safety.
// collation = the locale string, or null for the default binary comparison —
// two same-key indexes under different collations serve DIFFERENT queries.
export interface IndexSpec {
  readonly name: string;
  readonly keys: readonly IndexKey[];
  readonly unique: boolean;
  readonly ttl: boolean;
  readonly partial: boolean;
  // The actual partialFilterExpression, not just whether there is one. Two
  // partial indexes are only interchangeable if they filter on the same thing,
  // and a boolean cannot say that. Null for a full index, and for specs
  // persisted before this was captured.
  readonly partialFilter: Readonly<Record<string, unknown>> | null;
  readonly sparse: boolean;
  readonly hidden: boolean;
  readonly isShardKey: boolean;
  readonly collation: string | null;
}

// $indexStats is cumulative and per-member. `since` is when THAT member's
// counter started — it jumps forward when mongod restarts or the index is
// rebuilt, and the ops count begins again at zero. Without it a busy index is
// indistinguishable from a dead one immediately after a restart.
// Optional: snapshots collected before it was persisted simply lack it.
export interface MemberUsage {
  readonly member: string;
  readonly ops: number;
  readonly since?: string;
}

export interface UsageSnapshot {
  readonly capturedAt: string;
  readonly perMember: readonly MemberUsage[];
}
