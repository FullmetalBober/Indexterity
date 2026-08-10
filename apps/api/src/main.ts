// FIRST, before reflect-metadata and before Nest: the SDK instruments modules as
// they are required, so anything imported above it is invisible to it (#31).
import "./instrument.api";
// Before Nest, before better-auth, before anything that reads a value: an
// invalid environment is a boot failure that names the variable (#126).
import "./env.api";
import "reflect-metadata";
import rateLimit from "@fastify/rate-limit";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { auth } from "./auth";
import { sessionCookiesFor } from "./auth/session";
import { apiEnv, trustProxySetting } from "./config/env";
import { AppExceptionFilter } from "./errors/exception.filter";
import { captureAuthFailure } from "./errors/reporting";
import { securityHeaders } from "./http/security-headers";
import { jobDb } from "./jobs/db";
import { embeddedWorkerEnabled, startWorker } from "./jobs/runner";
import { instrumentHttp, registerControlPlaneGauges, startMetricsServer } from "./metrics";

async function bootstrap(): Promise<void> {
  // Fastify's built-in pino: structured request/response logs with req ids,
  // secrets redacted. LOG_LEVEL=debug for verbose, silent in tests.
  const adapter = new FastifyAdapter({
    // Without this, every request behind an ingress reports the proxy's address
    // and the per-IP rate limits become one shared bucket (see env.ts).
    trustProxy: trustProxySetting(),
    logger: {
      level: apiEnv().LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  // Everything this service serves lives under /api, so a single reverse proxy
  // rule can put it on the same origin as the dashboard. better-auth is already
  // mounted at /api/auth below — it registers straight on Fastify, outside
  // Nest's prefix, so it is unaffected by this and does not get /api twice.
  //
  // Same origin is what lets the browser hold the session cookie itself, and it
  // is a requirement rather than an optimisation: the dashboard has no relay to
  // fall back on, so a deployment that does not route /api here has a dashboard
  // whose every read 404s.
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new AppExceptionFilter());
  const fastify = app.getHttpAdapter().getInstance();
  // Before the routes exist, so the hooks see oRPC, better-auth and the health
  // check alike. That breadth is the whole point for the headers: better-auth
  // registers straight on Fastify, outside Nest, so anything scoped to a
  // controller would miss every endpoint that handles a credential.
  instrumentHttp(fastify);
  securityHeaders(fastify);

  // Global ceiling per IP, with a tight budget on the auth endpoints — they are
  // the brute-force target (sign-in/sign-up).
  //
  // Tunable because the right number depends on the deployment: one shared
  // office IP behind NAT, or a test suite that signs up fifteen accounts in a
  // minute, both look like an attack at the default. Raising it is a decision
  // an operator makes on purpose; the defaults stay where they are.
  await fastify.register(rateLimit, {
    max: apiEnv().RATE_LIMIT_MAX,
    timeWindow: "1 minute",
  });

  // When resolving the session refreshed the session-cache cookie
  // (auth.config.ts), hand the refreshed cookie to the browser. Without this,
  // only better-auth's own routes could re-arm the cache, and the dashboard
  // barely calls them — its traffic is the oRPC routes below, so the cache
  // would expire maxAge after sign-in and every request after that would be
  // back on postgres. Before listen, so the hook attaches to Nest's routes;
  // synchronous, because an async onSend races handlers that reply.send()
  // without returning the reply (see auth/session.ts).
  fastify.addHook("onSend", (request, reply, _payload, done) => {
    for (const cookie of sessionCookiesFor(request)) {
      reply.header("set-cookie", cookie);
    }
    done();
  });

  // Mount better-auth at /api/auth/*. Build a web Request from Fastify's parsed
  // request (reusing its JSON body), hand it to better-auth, forward the Response.
  fastify.all(
    "/api/auth/*",
    {
      config: {
        rateLimit: { max: apiEnv().AUTH_RATE_LIMIT_MAX, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      }
      const hasBody =
        request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined;
      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          body: hasBody ? JSON.stringify(request.body) : undefined,
        }),
      );
      // better-auth turns its own failures into a 500 rather than throwing, so
      // this is the only place an auth-route fault is visible to us (#31).
      if (response.status >= 500) {
        captureAuthFailure(request.method, url.pathname, response.status, String(request.id));
      }
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
      });
      for (const cookie of response.headers.getSetCookie()) reply.header("set-cookie", cookie);
      // Returned, not just called: an async handler that sends without
      // returning the reply makes Fastify send a second time when the promise
      // resolves — a logged warning that turns fatal the moment any onSend
      // hook gives the race somewhere to land.
      return reply.send(response.body ? await response.text() : null);
    },
  );

  // SIGTERM/SIGINT run the shutdown hooks (pools drained in DatabaseService)
  // instead of hanging until the container runtime SIGKILLs after 10s.
  app.enableShutdownHooks();

  // Its own port, off unless METRICS_ENABLED=true (see metrics/provider.ts). The
  // control-plane gauges reuse the jobs pool rather than opening a third one;
  // this process already drains it on shutdown. Started before the embedded
  // worker below, and before listen, so no measurement predates the endpoint.
  registerControlPlaneGauges(jobDb, (message) => fastify.log.warn(message));
  const metrics = await startMetricsServer({
    info: (message) => fastify.log.info(message),
    warn: (message) => fastify.log.warn(message),
  });
  if (metrics !== null) {
    process.once("SIGTERM", () => void metrics.stop());
    process.once("SIGINT", () => void metrics.stop());
  }

  // One-container mode for small and self-hosted installs. Off by default:
  // hosted keeps the worker separate so an api rollout cannot abort an
  // in-flight index build, and so the alert cooldown stays single-replica.
  if (embeddedWorkerEnabled()) {
    const runner = await startWorker();
    app.getHttpAdapter().getInstance().log.info("RUN_WORKER=true — job runner embedded in the api");
    process.once("SIGTERM", () => void runner.stop());
    process.once("SIGINT", () => void runner.stop());
  }

  const port = apiEnv().API_PORT;
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
