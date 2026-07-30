import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import { RequestValidationError } from "@ts-rest/nest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";

// One place for everything thrown: compact contract-validation 400s (instead of
// raw zod issue dumps), 502 for unreachable customer clusters, 404 for missing
// ones, and logged 500s with a request id — never a bare stack trace response.

function firstIssue(...errors: Array<ZodError | null>): string {
  for (const error of errors) {
    const issue = error?.issues[0];
    if (issue !== undefined) {
      const path = issue.path.join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    }
  }
  return "invalid request";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const UNREACHABLE_NAME = /MongoServerSelectionError|MongoNetworkError|MongoTimeoutError/;
const UNREACHABLE_MESSAGE = /getaddrinfo|ECONNREFUSED|ETIMEDOUT|Server selection timed out/i;

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    if (exception instanceof RequestValidationError) {
      void reply.status(400).send({
        message: firstIssue(
          exception.pathParams,
          exception.body,
          exception.query,
          exception.headers,
        ),
      });
      return;
    }

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const message =
        typeof response === "string"
          ? response
          : isRecord(response) && typeof response.message === "string"
            ? response.message
            : exception.message;
      void reply.status(exception.getStatus()).send({ message });
      return;
    }

    const error = exception instanceof Error ? exception : new Error(String(exception));
    if (UNREACHABLE_NAME.test(error.name) || UNREACHABLE_MESSAGE.test(error.message)) {
      request.log.error({ err: error }, "cluster unreachable");
      void reply.status(502).send({
        message: "cluster unreachable — check the connection string and network access",
        requestId: request.id,
      });
      return;
    }
    if (error.message.startsWith("cluster not found")) {
      void reply.status(404).send({ message: "cluster not found" });
      return;
    }

    request.log.error({ err: error }, "unhandled error");
    void reply.status(500).send({ message: "internal error", requestId: request.id });
  }
}
