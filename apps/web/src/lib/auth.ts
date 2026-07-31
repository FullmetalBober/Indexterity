import { createServerFn } from "@tanstack/react-start";
import { setCookie } from "@tanstack/react-start/server";

// Both are read at RUNTIME when set (the auth proxy runs server-side only), so
// one built image serves every environment; the VITE_* values remain the
// build-time defaults.
const runtimeEnv = typeof process === "undefined" ? undefined : process.env;
const apiUrl = runtimeEnv?.API_URL ?? import.meta.env.VITE_API_URL ?? "http://localhost:3001";
// This app's own origin — sent as Origin so better-auth accepts the request, and
// the origin the relayed session cookie is stored against.
const webOrigin =
  runtimeEnv?.WEB_ORIGIN ?? import.meta.env.VITE_WEB_ORIGIN ?? "http://localhost:3000";

interface CookieOptions {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
}

// Re-set each Set-Cookie from the api onto this app's response, so the browser
// stores the better-auth session cookie against the web origin.
function relaySetCookies(values: readonly string[]): void {
  for (const raw of values) {
    const parts = raw.split(";").map((part) => part.trim());
    const pair = parts[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const options: CookieOptions = {};
    for (const attr of parts.slice(1)) {
      const [rawKey, rawValue] = attr.split("=");
      const key = (rawKey ?? "").toLowerCase();
      if (key === "path") options.path = rawValue;
      else if (key === "domain") options.domain = rawValue;
      else if (key === "max-age") options.maxAge = Number(rawValue);
      else if (key === "expires" && rawValue !== undefined) options.expires = new Date(rawValue);
      else if (key === "httponly") options.httpOnly = true;
      else if (key === "secure") options.secure = true;
      else if (key === "samesite") {
        const same = (rawValue ?? "").toLowerCase();
        if (same === "lax" || same === "strict" || same === "none") options.sameSite = same;
      }
    }
    setCookie(name, value, options);
  }
}

async function proxy(path: string, body: unknown): Promise<{ ok: boolean; error: string | null }> {
  const res = await fetch(`${apiUrl}/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: webOrigin },
    body: JSON.stringify(body),
  });
  relaySetCookies(res.headers.getSetCookie());
  if (res.ok) return { ok: true, error: null };
  const parsed: unknown = await res.json().catch(() => null);
  const error =
    typeof parsed === "object" &&
    parsed !== null &&
    "message" in parsed &&
    typeof parsed.message === "string"
      ? parsed.message
      : "authentication failed";
  return { ok: false, error };
}

export const signIn = createServerFn({ method: "POST" })
  .validator((data: unknown): { email: string; password: string } => {
    if (
      typeof data === "object" &&
      data !== null &&
      "email" in data &&
      "password" in data &&
      typeof data.email === "string" &&
      typeof data.password === "string"
    ) {
      return { email: data.email, password: data.password };
    }
    throw new Error("invalid credentials");
  })
  .handler(({ data }) => proxy("sign-in/email", data));

export const signUp = createServerFn({ method: "POST" })
  .validator((data: unknown): { email: string; password: string; name: string } => {
    if (
      typeof data === "object" &&
      data !== null &&
      "email" in data &&
      "password" in data &&
      "name" in data &&
      typeof data.email === "string" &&
      typeof data.password === "string" &&
      typeof data.name === "string"
    ) {
      return { email: data.email, password: data.password, name: data.name };
    }
    throw new Error("invalid sign-up");
  })
  .handler(({ data }) => proxy("sign-up/email", data));

export const signOut = createServerFn({ method: "POST" }).handler(() => proxy("sign-out", {}));

// Asks the api to email a reset link. The redirect target is fixed server-side
// to this app's /reset-password page (never taken from the client).
export const requestPasswordReset = createServerFn({ method: "POST" })
  .validator((email: unknown): string => {
    if (typeof email !== "string" || email.length === 0) throw new Error("email required");
    return email;
  })
  .handler(({ data }) =>
    proxy("request-password-reset", { email: data, redirectTo: `${webOrigin}/reset-password` }),
  );

export const resetPassword = createServerFn({ method: "POST" })
  .validator((data: unknown): { token: string; newPassword: string } => {
    if (
      typeof data === "object" &&
      data !== null &&
      "token" in data &&
      "newPassword" in data &&
      typeof data.token === "string" &&
      typeof data.newPassword === "string"
    ) {
      return { token: data.token, newPassword: data.newPassword };
    }
    throw new Error("invalid reset");
  })
  .handler(({ data }) => proxy("reset-password", data));
