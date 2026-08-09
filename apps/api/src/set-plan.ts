import { entitlementsFor, isPlan, PLANS, planFrom } from "./billing/plans";
import { coreEnv, loadEnvOrExit } from "./config/env";
import { createDatabase, eq, organizations } from "./db";

// Move an organization onto a plan.
//
//   node apps/api/dist/set-plan.js <org-id|org-slug|org-name> <PLAN> [note]
//   node apps/api/dist/set-plan.js                          # list every org
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

async function main(): Promise<void> {
  loadEnvOrExit("migrate");
  const db = createDatabase(coreEnv().DATABASE_URL);
  const [target, plan, ...noteParts] = process.argv.slice(2);

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
