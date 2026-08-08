import { account, and, type Database, eq } from "../db";

// Whether this account can sign in with a password at all.
//
// The owner second-factor requirement (#55) applies exactly to these accounts:
// a password is what a stolen laptop or a phished inbox can replay, and TOTP is
// the second thing they would also need. An account that arrived through GitHub
// has no password here to steal and brings its provider's own second factor —
// and better-auth refuses to enrol a TOTP for it anyway (2FA is a
// credential-account feature), so demanding one would demand the impossible.
export async function hasCredentialAccount(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .limit(1);
  return row !== undefined;
}
