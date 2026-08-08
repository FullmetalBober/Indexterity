import { organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// better-auth's own client, talking to better-auth.
//
// This replaces five server functions that POSTed to the api's /api/auth and
// re-set every Set-Cookie onto this app's response, because the api was on
// another origin. That relay needed a hand-rolled `decodeOnce`: the api
// percent-encodes the cookie value and h3's setCookie encoded it again, so a
// base64 signature reached the browser double-escaped and every request after
// signing in was a 401. Same origin deletes the relay and that bug with it —
// the cookie the api sets is already first-party.
//
// Deliberately no baseURL. With none, the client resolves one from
// window.location.origin and appends /api/auth, which is where the api serves
// it (better-auth's default basePath, and the path the ingress routes). Writing
// an origin here would be a second copy of the deployment's own address to keep
// in step. Evaluated during SSR too — no window there, and the fallback is the
// relative "/api/auth" — but nothing calls it from the server: signing in is
// something a reader does, in a browser.
// The organization plugin is why this client does more than sign people in.
// Creating an org, renaming it, deleting it, inviting, accepting, changing a
// role, removing a member, leaving and switching are all its endpoints now —
// eight oRPC routes the api used to carry. What the api still answers is the
// plan and how much of it is spent, which is not a plugin concept (queries/
// shell.ts).
// twoFactorClient deliberately gets no onTwoFactorRedirect: the two places a
// sign-in happens (the auth form, the re-auth dialog) both handle the
// twoFactorRedirect answer inline as their own next step, and a global
// navigation would yank the reader out of whichever one they were in.
export const authClient = createAuthClient({
  plugins: [organizationClient(), twoFactorClient()],
});
