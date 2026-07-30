import "reflect-metadata";
import rateLimit from "@fastify/rate-limit";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { auth } from "./auth";
import { AppExceptionFilter } from "./errors/exception.filter";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.useGlobalFilters(new AppExceptionFilter());
  const fastify = app.getHttpAdapter().getInstance();

  // Global ceiling per IP, with a tight budget on the auth endpoints — they are
  // the brute-force target (sign-in/sign-up).
  await fastify.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // Mount better-auth at /api/auth/*. Build a web Request from Fastify's parsed
  // request (reusing its JSON body), hand it to better-auth, forward the Response.
  fastify.all(
    "/api/auth/*",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
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
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
      });
      for (const cookie of response.headers.getSetCookie()) reply.header("set-cookie", cookie);
      reply.send(response.body ? await response.text() : null);
    },
  );

  // SIGTERM/SIGINT run the shutdown hooks (pools drained in DatabaseService)
  // instead of hanging until the container runtime SIGKILLs after 10s.
  app.enableShutdownHooks();

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
