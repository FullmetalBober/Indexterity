import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { toNodeHandler } from "@repo/auth";
import { auth } from "./auth";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  // Mount better-auth at /api/auth/*. hijack() hands the raw response to it.
  const authHandler = toNodeHandler(auth);
  app
    .getHttpAdapter()
    .getInstance()
    .all("/api/auth/*", (request, reply) => {
      reply.hijack();
      void authHandler(request.raw, reply.raw);
    });

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
