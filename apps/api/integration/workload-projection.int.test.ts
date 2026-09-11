import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clusters,
  createDatabase,
  eq,
  organizations,
  type workloadShapes as ShapesTable,
  workloadShapes,
} from "../src/db";
import { InsightsRepository } from "../src/insights/insights.repository";
import { databaseUrl } from "./helpers";

// A weekly figure needs a week's worth of watching to be one (#509).
//
// Against a real postgres because the gate is a SQL `case` over three columns of
// the row, and because the thing worth proving is not the arithmetic but the
// RANKING: the page sorts on this expression, and before the gate a shape seen
// three times over two hours headed the customer's most-expensive-queries list.
// On the hosted deployment that was `msb-app.exercise-tags` in third place, at
// 163 million documents a week, on one execution.

const ORG = "1a7e0000-0000-4000-8000-00000000f003";
const CLUSTER = "1a7e0000-0000-4000-8000-00000000c003";
const HOUR = 3_600_000;

let db: ReturnType<typeof createDatabase>;
let repo: InsightsRepository;

const ago = (ms: number): Date => new Date(Date.now() - ms);

type ShapeRow = typeof ShapesTable.$inferInsert;
const shape = (
  collection: string,
  weekly: number,
  observations: number,
  lifetimeHours: number,
): ShapeRow => ({
  clusterId: CLUSTER,
  database: "app",
  collection,
  // The digest is generated from this, so two rows differing here are two rows.
  shape: { equality: [collection], sort: [], range: [], collscan: true },
  executions: 10,
  docsExamined: 1_000,
  observedForHours: 2,
  clients: [],
  weeklyDocsExamined: weekly,
  severity: "ROUTINE",
  outcome: "proposed",
  firstSeenAt: ago(lifetimeHours * HOUR),
  lastSeenAt: new Date(),
  observations,
});

beforeAll(async () => {
  db = createDatabase(databaseUrl(), 2);
  repo = new InsightsRepository({ db });
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Projection", slug: `projection-${process.pid}`, plan: "PRO" })
    .onConflictDoNothing();
  await db
    .insert(clusters)
    .values({
      id: CLUSTER,
      orgId: ORG,
      name: "projection",
      connectionMode: "HOSTED_DIRECT",
      sealedDek: Buffer.from([0]),
      sealedData: Buffer.from([0]),
      engine: "MONGODB",
    })
    .onConflictDoNothing();
  await db.delete(workloadShapes).where(eq(workloadShapes.clusterId, CLUSTER));
  await db.insert(workloadShapes).values([
    // Watched for a week and confirmed 275 times — the msb-app.video-record
    // shape, which is high BECAUSE it is busy and must keep its number.
    shape("established", 50_000_000, 275, 168),
    // Three confirmations over two hours, projected to 163 million a week.
    shape("thin", 163_000_000, 3, 2),
    // Clears the confirmations floor but not the lifetime one.
    shape("young", 99_000_000, 40, 5),
    // Clears the lifetime floor but not the confirmations one.
    shape("sparse", 88_000_000, 4, 96),
  ]);
});

afterAll(async () => {
  await db.delete(workloadShapes).where(eq(workloadShapes.clusterId, CLUSTER));
  await db.delete(clusters).where(eq(clusters.id, CLUSTER));
  await db.delete(organizations).where(eq(organizations.id, ORG));
});

const page = async () => await repo.workloadShapePage(CLUSTER, ago(30 * 24 * HOUR), {}, 10, 0);

describe("the weekly cost a shape is allowed to claim", () => {
  it("keeps the figure for a shape watched long enough to have one", async () => {
    const { rows } = await page();
    const row = rows.find((r) => r.collection === "established");
    expect(row?.weeklyDocsExamined).toBe(50_000_000);
  });

  it("reports no figure where the evidence does not reach a week", async () => {
    const { rows } = await page();
    for (const collection of ["thin", "young", "sparse"]) {
      expect(rows.find((r) => r.collection === collection)?.weeklyDocsExamined).toBeNull();
    }
  });

  // The point of the change: unmeasured is not worst, so the thin rows sort
  // BELOW the one real cost rather than above it.
  it("ranks the shape we can measure above the ones we cannot", async () => {
    const { rows } = await page();
    expect(rows[0]?.collection).toBe("established");
  });
});
