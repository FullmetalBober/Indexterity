import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, eq, session, user, verification } from "../src/db";
import { pruneExpiredAuthRows } from "../src/jobs/retention";
import { databaseUrl } from "./helpers";

// `session` grows with every sign-in and `verification` with every emailed link,
// and until #499 nothing deleted either. Two of the four session rows on the
// hosted deployment were already past `expires_at`.
//
// Against a real postgres because the claim is about what a DELETE with a
// timestamp predicate removes, and the rows are better-auth's — the one thing
// worth being sure of is that an unexpired session is still there afterwards.

const USER = "1a7e0000-0000-4000-8000-00000000e001";
const HOUR = 3_600_000;

let db: ReturnType<typeof createDatabase>;

const at = (offsetMs: number): Date => new Date(Date.now() + offsetMs);

beforeAll(async () => {
  db = createDatabase(databaseUrl(), 2);
  await db
    .insert(user)
    .values({
      id: USER,
      name: "Retention",
      email: `retention-${process.pid}@example.test`,
      emailVerified: true,
    })
    .onConflictDoNothing();
  await db.delete(session).where(eq(session.userId, USER));
  await db.insert(session).values([
    { id: `${USER}-live`, token: `live-${process.pid}`, userId: USER, expiresAt: at(HOUR) },
    { id: `${USER}-dead`, token: `dead-${process.pid}`, userId: USER, expiresAt: at(-HOUR) },
  ]);
  await db.insert(verification).values([
    {
      id: `${USER}-v-live`,
      identifier: `live-${process.pid}`,
      value: "x",
      expiresAt: at(HOUR),
    },
    {
      id: `${USER}-v-dead`,
      identifier: `dead-${process.pid}`,
      value: "x",
      expiresAt: at(-HOUR),
    },
  ]);
});

afterAll(async () => {
  await db.delete(session).where(eq(session.userId, USER));
  await db.delete(verification).where(eq(verification.id, `${USER}-v-live`));
  await db.delete(user).where(eq(user.id, USER));
});

describe("pruneExpiredAuthRows", () => {
  it("removes what has expired and keeps what has not", async () => {
    const removed = await pruneExpiredAuthRows(db);
    expect(removed).toBeGreaterThanOrEqual(2);
    const sessions = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, USER));
    expect(sessions.map((row) => row.id)).toEqual([`${USER}-live`]);
    const live = await db
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.id, `${USER}-v-live`));
    const dead = await db
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.id, `${USER}-v-dead`));
    expect(live).toHaveLength(1);
    expect(dead).toHaveLength(0);
  });

  it("is a no-op the second time", async () => {
    await pruneExpiredAuthRows(db);
    const sessions = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, USER));
    expect(sessions.map((row) => row.id)).toEqual([`${USER}-live`]);
  });
});
