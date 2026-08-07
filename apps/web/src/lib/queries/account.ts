// The three reads behind the account page: who is signed in, the sessions open
// for them, and the sign-in methods on the account.
//
// They go through better-auth's client, which resolves its URL from the
// browser's origin (lib/auth-client.ts) — so unlike the org-level reads these
// are browser-only and deliberately in no route loader. During SSR the page
// renders its empty state once and hydrates into the answer, which is the same
// deal every panel gets while a read has not arrived.
import { queryOptions, useQuery } from "@tanstack/react-query";
import { authClient } from "../auth-client";
import { unwrap } from "./errors";
import { queryKeys } from "./keys";

// better-auth's own idea of the signed-in pair; a list-sessions row is the
// session half of it.
export type Me = (typeof authClient)["$Infer"]["Session"];
export type SessionEntry = Me["session"];

// What the page reads off an account row — better-auth returns more, and the
// only question asked here is "which providers, and is `credential` among
// them", because that decides whether a change-password form can work at all.
export interface ProviderAccount {
  readonly providerId: string;
}

// Stable fallbacks — see the note in telemetry.ts.
const NO_SESSIONS: SessionEntry[] = [];
const NO_ACCOUNTS: ProviderAccount[] = [];

export function meQuery() {
  return queryOptions({
    queryKey: queryKeys.me(),
    queryFn: () => unwrap(authClient.getSession()),
  });
}

export function mySessionsQuery() {
  return queryOptions({
    queryKey: queryKeys.mySessions(),
    queryFn: () => unwrap(authClient.listSessions()),
  });
}

export function myAccountsQuery() {
  return queryOptions({
    queryKey: queryKeys.myAccounts(),
    queryFn: () => unwrap(authClient.listAccounts()),
  });
}

// Null while it has not arrived or the read failed. The /app layout has already
// decided the reader is signed in, so both cases render nothing rather than a
// sign-in prompt.
export function useMe(): Me | null {
  const { data = null } = useQuery(meQuery());
  return data;
}

export function useMySessions(): readonly SessionEntry[] {
  const { data = NO_SESSIONS } = useQuery(mySessionsQuery());
  return data;
}

export function useMyAccounts(): readonly ProviderAccount[] {
  const { data = NO_ACCOUNTS } = useQuery(myAccountsQuery());
  return data;
}
