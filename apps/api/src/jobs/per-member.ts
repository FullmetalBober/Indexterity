import type { MemberUsage } from "../analysis";
import { type Database, indexSnapshots, sql } from "../db";

// Per-member usage, shipped compactly and rebuilt here (#474).
//
// `index_snapshots.per_member` is an array of `{ops, since, member}` and it is
// the single largest thing the classify pass reads — 13 MB of the 20 MB it takes
// over the wire on the hosted deployment. Two thirds of that is repetition
// rather than information:
//
//   [{"ops": 88388, "since": "2026-08-27T13:48:06.307Z",
//     "member": "atlas-7eudp5-shard-00-03.hwrel.mongodb.net:27017"}, …]
//
// The three key names cost about 30 bytes an element, and the HOSTNAME costs 47
// — one of five fixed strings on that cluster, repeated on every element of all
// 42,830 rows. Measured against production: as arrays rather than objects the
// same data is 10,142 kB (24% off), and with the hostname interned it is
// 4,281 kB (68% off).
//
// Nothing about STORAGE changes. This is a projection: the rows stay exactly as
// collect wrote them, and what shrinks is the encoding on the wire. That is what
// makes it worth doing at all — the alternative reading of "shrink perMember"
// was a migration, and it turned out not to be necessary.
//
// node-postgres reads results in TEXT format, so the bytes that cross are the
// JSON text of this expression, which is why the measurements above are text
// lengths rather than `pg_column_size`.

/**
 * The distinct member names one classify pass will see.
 *
 * Read as its own statement so the encoder below can be handed the array and
 * emit positions into it. Five rows on the deployment this was written for.
 */
export async function memberDictionary(
  db: Database,
  clusterId: string,
  since: Date,
): Promise<string[]> {
  const rows = await db.execute<{ member: string }>(sql`
    select distinct member.value->>'member' as member
      from ${indexSnapshots} as s,
           lateral jsonb_array_elements(s.per_member) as member
     where s.cluster_id = ${clusterId}
       and s.last_seen_at >= ${since.toISOString()}
       and member.value->>'member' is not null
     order by 1`);
  return rows.rows.map((row) => row.member);
}

/**
 * `per_member`, as `[ops, since, member]` triples with the member interned
 * against `dictionary`.
 *
 * The member is emitted as its POSITION in the dictionary, and falls back to the
 * name itself when the dictionary has no entry for it. That fallback is
 * the whole reason this is safe to run as two statements: the dictionary and the
 * rows are separate reads, so a collect landing between them could introduce a
 * member the dictionary has never heard of. Encoding it inline costs the bytes
 * this exists to save, for one row, rather than losing which member a reading
 * belongs to — and `decodeMembers` accepts either.
 *
 * `jsonb_agg` over an empty array returns NULL rather than `[]`, so the coalesce
 * is what keeps an index with no members reading as none rather than as absent.
 */
export function compactMembers(dictionary: readonly string[]) {
  // A bound JSON OBJECT mapping name to position, not a `text[]` and not a
  // delimited string. Three reasons, and the first is that the obvious spellings
  // do not work: drizzle binds a JS array as one scalar parameter, so
  // `${dictionary}::text[]` reaches postgres as the string `m1` and is rejected
  // as a malformed array literal (22P02) — the same wall `jobs/locks.ts` hit,
  // which it got past with `string_to_array` over a comma-joined list.
  //
  // A separator would work here too and is not worth the assumption: these are
  // hostnames off a customer's cluster, and "no member name contains the
  // delimiter" is a claim about their infrastructure rather than about ours. A
  // JSON object holds any string postgres can store.
  //
  // And it is one key lookup per element against a constant, where
  // `array_position` is a scan of the dictionary per element.
  const positions = JSON.stringify(Object.fromEntries(dictionary.map((name, at) => [name, at])));
  return sql<unknown>`coalesce((
    select jsonb_agg(jsonb_build_array(
             member.value->'ops',
             member.value->'since',
             coalesce(
               ${positions}::jsonb -> (member.value->>'member'),
               member.value->'member')))
      from jsonb_array_elements(${indexSnapshots.perMember}) as member
  ), '[]'::jsonb)`;
}

/**
 * Back to what the analysis is written for.
 *
 * Checked rather than asserted, every element: this is the one place a wire
 * format is being trusted, `sql<T>` promises nothing about what actually arrives
 * (the driver decodes jsonb, it does not validate it), and a reading rebuilt
 * wrong would be a wrong number handed to the gate that decides whether an index
 * is used. A row that does not decode contributes nothing rather than a guess.
 *
 * `since` is optional on `MemberUsage` and stays optional: absent and null both
 * mean the counter's start is unknown, which the epoch rules already handle.
 */
export function decodeMembers(value: unknown, dictionary: readonly string[]): MemberUsage[] {
  if (!Array.isArray(value)) return [];
  const members: MemberUsage[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    // Indexed off the checked array rather than destructured through a tuple
    // type: `Array.isArray` earns `unknown[]` and nothing more, and claiming a
    // three-tuple here would be an assertion about the wire (lint-assertions).
    const [ops, since, member] = entry;
    // A position into the dictionary, or the name itself when the encoder could
    // not find one. Both are expected; anything else is not a reading.
    const name =
      typeof member === "string"
        ? member
        : typeof member === "number"
          ? dictionary[member]
          : undefined;
    if (name === undefined || typeof ops !== "number") continue;
    members.push(typeof since === "string" ? { member: name, ops, since } : { member: name, ops });
  }
  return members;
}
