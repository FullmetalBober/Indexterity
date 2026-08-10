import { DEFAULT_PLAN, entitlementsFor, isPlan, PLANS, type Plan, planFrom } from "./billing/plans";
import { coreEnv, loadEnvOrExit } from "./config/env";
import { and, createDatabase, type Database, eq, isNull, ne, organizations } from "./db";

// Move an organization onto a plan.
//
//   node apps/api/dist/set-plan.js <org-id|org-slug|org-name> <PLAN> [note]
//   node apps/api/dist/set-plan.js                          # list every org
//   node apps/api/dist/set-plan.js --backfill <PLAN>        # what --apply would move
//   node apps/api/dist/set-plan.js --backfill <PLAN> --apply
//
// This is the whole billing integration today, and it is enough to charge
// people: send an invoice, run this when it clears. No provider is wired, and
// nothing in the engine cares which one eventually is — plans decide what an
// org may do (billing/plans.ts), and a webhook would set exactly the same
// column this does.
//
// The note is for whoever reads the row in a year: an invoice number, a trial
// end date, "founding customer". It is never shown to the customer.
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function describeLimit(value: number): string {
  return Number.isFinite(value) ? String(value) : "unlimited";
}

// Organizations whose plan nobody ever chose (#132).
//
// Until DEFAULT_ORG_PLAN was read, the column's DDL default decided, so an
// install that has been running a while has orgs sitting on `FREE` that were
// meant to be `SELF_HOSTED` — the fix above only reaches orgs created after it.
// This is the rest of them, and the whole design of it is about being safe on a
// HOSTED deployment as well as a self-hosted one:
//
//   * three guards, not one. `plan = FREE` is the one that says which orgs this
//     is FOR — the ones the DDL default decided for, since that default was
//     FREE. `planUpdatedAt IS NULL` means neither this script nor a webhook has
//     ever written the row, and `billingSubscriptionId IS NULL` means no provider
//     owns it. A paying customer fails at least two of the three, so no argument
//     to this command can move one.
//   * the plan is an argument, never DEFAULT_ORG_PLAN. Reading the deployment's
//     variable would make "which orgs move where" depend on a value the operator
//     may not have in front of them, and the failure would be silent and
//     wholesale — exactly the shape of the bug this fixes.
//   * it prints and changes nothing unless told twice. `--apply` is the second
//     time.
//
// The `plan = FREE` guard was added after running the dry run against a database
// with history in it: `planUpdatedAt IS NULL` alone matched organizations sitting
// on SCALE, because anything that writes the column without also writing the
// timestamp — an integration test, a hand-run UPDATE — looks exactly like an org
// nobody ever chose for. Every one of those would have been silently DOWNGRADED,
// which is the opposite of what a command called backfill should be able to do.
const NEVER_CHOSEN = "no plan was ever chosen for it";

// The plan the DDL default used to impose, and so the only plan this moves FROM.
const WAS_THE_DEFAULT = DEFAULT_PLAN;

function neverChosen(plan: Plan) {
  return and(
    eq(organizations.plan, WAS_THE_DEFAULT),
    isNull(organizations.planUpdatedAt),
    isNull(organizations.billingSubscriptionId),
    ne(organizations.plan, plan),
  );
}

async function backfill(db: Database, plan: Plan, apply: boolean): Promise<void> {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      plan: organizations.plan,
    })
    .from(organizations)
    .where(neverChosen(plan));

  if (rows.length === 0) {
    console.log(
      `nothing to move: no organization is on ${WAS_THE_DEFAULT} with a plan nobody chose`,
    );
    return;
  }

  for (const row of rows)
    console.log(`  ${row.id}  ${row.plan} -> ${plan}  ${row.name} (${row.slug})`);
  if (!apply) {
    console.log(
      `\n${rows.length} organization(s) would move to ${plan}. Nothing was changed — ` +
        `re-run with --apply.`,
    );
    return;
  }

  // The same predicate, not a list of the ids just selected: the UPDATE has to
  // be re-evaluated against the rows as they are now, so an org that acquired a
  // chosen plan between the SELECT and here is left alone rather than overwritten
  // from a stale read.
  await db
    .update(organizations)
    .set({ plan, planUpdatedAt: new Date(), planNote: NEVER_CHOSEN })
    .where(neverChosen(plan));
  console.log(`\n${rows.length} organization(s) moved to ${plan}.`);
}

async function main(): Promise<void> {
  loadEnvOrExit("migrate");
  const db = createDatabase(coreEnv().DATABASE_URL);
  const argv = process.argv.slice(2);

  if (argv[0] === "--backfill") {
    const plan = argv[1];
    if (plan === undefined || !isPlan(plan)) fail(`--backfill needs a plan: ${PLANS.join(", ")}`);
    await backfill(db, plan, argv.includes("--apply"));
    return;
  }

  const [target, plan, ...noteParts] = argv;

  if (target === undefined) {
    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        plan: organizations.plan,
        note: organizations.planNote,
      })
      .from(organizations);
    if (rows.length === 0) {
      console.log("no organizations");
      return;
    }
    // The slug is on the line because names are not unique and a support email
    // gives you a name. Two orgs called Acme are one `set-plan.js Acme` away
    // from an operator having to go and find the ids by hand.
    for (const row of rows) {
      console.log(
        `${row.id}  ${row.plan.padEnd(6)}  ${row.name}  (${row.slug})${
          row.note === null ? "" : `  — ${row.note}`
        }`,
      );
    }
    return;
  }

  if (plan === undefined || !isPlan(plan)) {
    fail(`plan must be one of: ${PLANS.join(", ")}`);
  }

  // Accept an id, a slug or a name — an operator reading a support email has
  // the name, and the slug is the one of the three that is unique.
  const rows = await db.select().from(organizations);
  const matches = rows.filter(
    (row) => row.id === target || row.slug === target || row.name === target,
  );
  if (matches.length === 0) fail(`no organization matching ${JSON.stringify(target)}`);
  if (matches.length > 1) {
    fail(
      `${matches.length} organizations are named ${JSON.stringify(target)} — use an id or slug:\n` +
        matches.map((row) => `  ${row.id}  ${row.slug}`).join("\n"),
    );
  }
  const org = matches[0];
  if (org === undefined) fail("unreachable");

  const note = noteParts.length > 0 ? noteParts.join(" ") : null;
  await db
    .update(organizations)
    .set({ plan, planUpdatedAt: new Date(), planNote: note })
    .where(eq(organizations.id, org.id));

  const before = planFrom(org.plan);
  const limits = entitlementsFor(plan);
  console.log(`${org.name} (${org.id}): ${before} -> ${plan}`);
  console.log(
    `  clusters ${describeLimit(limits.maxClusters)}, members ${describeLimit(limits.maxMembers)}, ` +
      `workload analysis ${limits.workloadAnalysis ? "on" : "off"}, history ${limits.retentionDays}d`,
  );
  // Downgrades do not delete anything. An org over its new limit keeps what it
  // has and simply cannot add more — taking a customer's clusters away because
  // an invoice is late is not a decision a script should make.
  console.log("  existing clusters and members are left alone; only new ones are gated");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
