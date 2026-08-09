import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ClusterGoneError } from "../jobs/cluster-connection";
import { captureError } from "./reporting";
import { isUnreachableError } from "./unreachable";

// Catches everything thrown OUTSIDE the oRPC pipeline (the better-auth mount,
// Nest-level failures): 502 for unreachable customer clusters, 404 for missing
// ones, logged 500s with a request id — never a bare stack trace response.
// Handler-level errors are oRPC's job (see mapClusterError in the controller).
//
// Error reporting (#31) hangs off the LAST branch only, by hand, and not off
// @SentryExceptionCaptured(). The decorator's own filter (isExpectedError in
// @sentry/nestjs) stands down for HttpException and nothing else, so wearing it
// here would report every branch below it as an unhandled fault: a rate-limited
// client (429 — a Fastify error, not an HttpException), a payload that was too
// large, a cluster whose owner's firewall is doing its job, and a 404. Three of
// those are this service working correctly, and the unreachable one is a handled
// condition by §7.4.1 — it would page us about a customer's network.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

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
    // Fastify-flavored errors (rate limit's 429, payload-too-large, …) carry a
    // statusCode — honor it instead of flattening them into 500s.
    if ("statusCode" in error && typeof error.statusCode === "number") {
      const statusCode = error.statusCode;
      if (statusCode >= 400 && statusCode < 600) {
        void reply.status(statusCode).send({ message: error.message });
        return;
      }
    }
    if (isUnreachableError(error)) {
      request.log.warn({ err: error }, "cluster unreachable");
      void reply.status(502).send({
        message: "cluster unreachable — check the connection string and network access",
        requestId: request.id,
      });
      return;
    }
    if (error instanceof ClusterGoneError) {
      void reply.status(404).send({ message: "cluster not found" });
      return;
    }

    // Everything above was classified; this is the one that was not. Tagged with
    // the id Fastify already put in the log line and in the response body, so the
    // three can be joined from any one of them.
    request.log.error({ err: error }, "unhandled error");
    captureError(error, { requestId: String(request.id) });
    void reply.status(500).send({ message: "internal error", requestId: request.id });
  }
}
