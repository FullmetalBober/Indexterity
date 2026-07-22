import { createDatabase, eq, user } from "@repo/db";
import { auth } from "./auth";
import { requiredEnv } from "./env";

// Proves better-auth works against Postgres: sign up via the server API, then
// confirm the user row exists.
async function main(): Promise<void> {
  const email = `demo+${Date.now()}@example.com`;
  const result = await auth.api.signUpEmail({
    body: { email, password: "password12345", name: "Demo User" },
  });
  console.log("sign-up ok:", JSON.stringify(result, null, 2));

  const db = createDatabase(requiredEnv("DATABASE_URL"));
  const rows = await db.select().from(user).where(eq(user.email, email));
  console.log(`user rows in Postgres for ${email}: ${rows.length}`);
  process.exit(0);
}

void main();
