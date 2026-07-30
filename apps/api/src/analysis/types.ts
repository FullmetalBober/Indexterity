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
  readonly sparse: boolean;
  readonly hidden: boolean;
  readonly isShardKey: boolean;
  readonly collation: string | null;
}

// $indexStats is cumulative-since-restart and per-member; capture uptime so a
// short-lived member's zero count is not mistaken for "unused".
export interface MemberUsage {
  readonly member: string;
  readonly ops: number;
  readonly since: string;
  readonly uptimeSeconds: number;
}

export interface UsageSnapshot {
  readonly capturedAt: string;
  readonly perMember: readonly MemberUsage[];
}
