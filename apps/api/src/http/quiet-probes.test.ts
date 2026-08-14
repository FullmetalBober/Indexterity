import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { quietProbes } from "./quiet-probes";

// Asserted against a real Fastify instance rather than a spy on addHook, because
// what is being claimed is that the LINES STOP — and the only thing that decides
// that is whether Fastify saw `logLevel` on the route before it registered it.
// A test that checked the hook was added would pass with the wrong route name, the
// wrong property, or a hook registered too late.
//
// The log is captured by giving Fastify a stream, which is what it writes request
// lines to.
function appWithCapturedLog(): { app: ReturnType<typeof Fastify>; lines: string[] } {
  const lines: string[] = [];
  const app = Fastify({
    logger: {
      level: "info",
      stream: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    },
  });
  return { app, lines };
}

describe("quietProbes", () => {
  it("stops the two request lines a health probe would otherwise write", async () => {
    const { app, lines } = appWithCapturedLog();
    quietProbes(app);
    app.get("/api/health", () => ({ status: "ok" }));
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(lines.filter((line) => line.includes("/api/health"))).toEqual([]);
    await app.close();
  });

  it("leaves every other route logging, which is the point of doing it per route", async () => {
    const { app, lines } = appWithCapturedLog();
    quietProbes(app);
    app.get("/api/clusters", () => []);
    await app.ready();

    await app.inject({ method: "GET", url: "/api/clusters" });
    // Fastify writes "incoming request" and "request completed"; asserting on the
    // count rather than the wording, which is the framework's to change.
    expect(lines.filter((line) => line.includes("/api/clusters")).length).toBeGreaterThan(0);
    await app.close();
  });

  it("does not silence a route that merely starts with the quiet one's path", async () => {
    const { app, lines } = appWithCapturedLog();
    quietProbes(app);
    app.get("/api/healthcheck-details", () => ({}));
    await app.ready();

    await app.inject({ method: "GET", url: "/api/healthcheck-details" });
    expect(lines.filter((line) => line.includes("healthcheck-details")).length).toBeGreaterThan(0);
    await app.close();
  });
});
