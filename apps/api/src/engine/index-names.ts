import type { SortKey } from "./types";

// The name a proposed index is built under, on an engine whose index names are
// unique per TABLE — MongoDB's per collection, SQL Server's per table. The keys
// and their directions, the way MongoDB names an index it was not given a name
// for: `customer_id_1_created_at_-1`. A partial index built from a shape's
// constants is told apart from the full index of the same keys by a suffix.
//
// PostgreSQL's names are unique per SCHEMA, so it names its own (#617, see
// postgres/executor.ts `postgresIndexName`): there, two tables wanting the same
// keys would want the same name.
export function keyedIndexName(
  keys: readonly SortKey[],
  options: { readonly partial?: boolean } = {},
): string {
  const name = keys.map((key) => `${key.field}_${key.direction}`).join("_");
  return options.partial === true ? `${name}_partial` : name;
}
