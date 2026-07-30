import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const API_PORT = Number(process.env.INT_API_PORT ?? 3099);
export const API_BASE = `http://localhost:${API_PORT}`;
export const WEB_ORIGIN = "http://localhost:3000";
export const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017";

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    throw new Error("integration tests need DATABASE_URL (a migrated postgres)");
  }
  return url;
}

// Spawn the built api and wait for /health. The caller owns teardown.
export async function startApi(): Promise<ChildProcess> {
  const entry = path.resolve(__dirname, "../dist/main.js");
  if (!existsSync(entry)) {
    throw new Error("dist/main.js missing — run `turbo run build` before the integration suite");
  }
  const child = spawn("node", [entry], {
    env: {
      ...process.env,
      API_PORT: String(API_PORT),
      WEB_ORIGIN,
      DATABASE_URL: databaseUrl(),
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "integration-secret",
      MASTER_KEY:
        process.env.MASTER_KEY ??
        Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (res.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  child.kill("SIGKILL");
  throw new Error("api did not become healthy in 60s");
}

export async function stopApi(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export interface Session {
  readonly email: string;
  readonly cookie: string;
}

export async function signUp(prefix: string): Promise<Session> {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@int.test`;
  const res = await fetch(`${API_BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: "password12345", name: prefix }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { email, cookie };
}

export async function api(
  path: string,
  session: Session | null,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      // Only claim a JSON body when one is sent — fastify 400s on an empty
      // JSON body (bit the body-less DELETE).
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...(session === null ? {} : { cookie: session.cookie }),
      ...init?.headers,
    },
  });
}
