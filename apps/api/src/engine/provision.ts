import type { ClusterEngine } from "./ports";
import { adapterFor } from "./registry";

// Scoped-user provisioning, in the part of it that is the same on every engine.
//
// How a user is created is entirely per engine — a MongoDB role with actions, a
// PostgreSQL role with GRANTs, a SQL Server login with a user per database. Two
// things are not, and they lived in mongo/provision.ts until #329 only because
// that is where the first adapter put them (#325 added them there for exactly
// that reason: the existing pattern pointed at it).

// One name on every engine, so a second connection of the same server is
// refused BY THE SERVER — no uniqueness rule invented over connection strings
// that can spell one server a dozen ways (srv vs seed list, alias vs IP, with
// or without a database, any ordering of options). The name is the identity.
//
// Only the password is generated. Re-provisioning after a real offboard is
// therefore drop-then-provision, which is the command the disconnect screen
// already hands over.
export const SCOPED_USERNAME = "indexterity";

// The credentials lack the privilege to create the user. Surfaced as a 422 by
// the controller, for all three engines.
export class ProvisionDeniedError extends Error {}

// What a second provision against the same server is told, shared by all three
// engines. It states both readings because the server cannot tell them apart:
// either this database is already connected to Indexterity, or an earlier
// connection was removed and the user outlived it. Naming the drop statement is
// what keeps the second case from being a dead end — provisioning is otherwise
// unreachable forever on a cluster carrying an orphan.
//
// The drop command itself is the caller's, because it is engine-specific:
// `db.getSiblingDB("admin").dropUser(…)`, `DROP ROLE …`, `DROP LOGIN …`.
export function alreadyProvisionedMessage(dropCommand: string): string {
  return (
    `this cluster already has an Indexterity user called "${SCOPED_USERNAME}", so it is ` +
    "already connected here — open that cluster instead of adding the same one twice. " +
    "If it was disconnected and the user was left behind, remove it with " +
    `${dropCommand} and provision again.`
  );
}

// The statement(s) that remove the least-privilege user Indexterity created
// during admin-string onboarding. Null when the customer pasted a ready-made
// string, because then there is nothing of ours on their cluster.
//
// Handed back rather than run: dropping a user needs admin credentials we
// deliberately did not keep, and guessing that the analysis credentials will do
// it would fail at exactly the moment nobody is watching.
//
// Asked of the adapter rather than written here (#338). This used to emit
// MongoDB's `dropUser` for all three engines, which is unusable on two of them
// and fails silently — the screen prints something that cannot work, against a
// server that has never heard of `db.getSiblingDB`. The engine is on the row and
// every adapter already had its own statement.
//
// `databases` is null on rows provisioned before the column existed. The
// statement is still correct for MongoDB, which needs no list; for the other two
// it degrades to a bare drop, which postgres and SQL Server both refuse while the
// per-database grants remain — so those rows get the refusal rather than a wrong
// answer, and the wiki's per-engine table is what closes the gap.
export function revokeCommandFor(
  engine: ClusterEngine,
  provisionedUsername: string | null,
  databases: readonly string[] | null,
): string | null {
  if (provisionedUsername === null) return null;
  return adapterFor(engine).revokeStatements(provisionedUsername, databases ?? []);
}
