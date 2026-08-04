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
export const authClient = createAuthClient();
