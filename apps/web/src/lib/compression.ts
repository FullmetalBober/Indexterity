import type { Transform } from "node:stream";
import { constants, createBrotliCompress, createGzip } from "node:zlib";

// Responses compressed at the origin (#614).
//
// The hosted deployment sits behind a CDN that compresses for the browser — and
// its host bills the bytes it sends to that CDN, which arrived raw: every API
// read, relayed through this server, and every page it renders. Measured on
// 2026-10-04, the host's outbound pace was 7 GB a month against a free 5 GB.
// JSON and HTML compress five to ten times, so this is most of it.
//
// The built assets are not handled here. Nitro's static handler answers them
// before this server runs, and it serves the variants `compressPublicAssets`
// writes at build time (vite.config.ts).

// What is worth compressing: text, JSON, JavaScript, XML and SVG. An event
// stream is text and must never be: a compressor holds output back until it has
// enough to work with, and the dashboard's live updates would sit in its buffer.
const COMPRESSIBLE =
  /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/i;

// Below this a known length is left alone: the framing costs about what it saves.
const MIN_BYTES = 1024;

// Brotli at 5, not its default 11: these are compressed once per response, not
// once per build, and 11 spends tens of milliseconds a response for a few
// percent. Gzip's default 6 for a client that does not take brotli.
const BROTLI_QUALITY = 5;

// What createServerEntry takes and wrapFetchWithSentry returns: one fetch.
export interface FetchEntry {
  fetch(request: Request, opts?: unknown): Response | Promise<Response>;
}

/**
 * An entry whose every response leaves compressed — compression applied to
 * what `entry` returns, so after anything `entry` does to a response.
 *
 * That order is the whole of it (#621). Sentry's fetch wrapper reads every HTML
 * response as UTF-8 text to put its trace tags in the head, and keeps the
 * headers. Compressed beneath it, a brotli body was decoded as text — every
 * byte that was not valid UTF-8 became U+FFFD — re-encoded, and sent on as
 * `br`, and the hosted dashboard served pages of garbage. Nothing that ran
 * without a DSN could see it: not the unit tests, the built server, kind or CI.
 */
export function compressedEntry(entry: FetchEntry): FetchEntry {
  return {
    fetch: async (request, opts) => compressedResponse(request, await entry.fetch(request, opts)),
  };
}

/** The encoding to answer with, from the request's Accept-Encoding: brotli first. */
export function negotiateEncoding(acceptEncoding: string | null): "br" | "gzip" | null {
  if (acceptEncoding === null) return null;
  const offered = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    offered.set(name.trim(), q === undefined ? 1 : Number(q.slice(2)));
  }
  const accepts = (name: string) => {
    const q = offered.get(name) ?? offered.get("*");
    return q !== undefined && Number.isFinite(q) && q > 0;
  };
  if (accepts("br")) return "br";
  if (accepts("gzip")) return "gzip";
  return null;
}

/** The response, compressed for this request where it is worth it and safe to. */
export function compressedResponse(request: Request, response: Response): Response {
  if (response.body === null || request.method === "HEAD") return response;
  if (response.status === 204 || response.status === 206 || response.status === 304) {
    return response;
  }
  if (response.headers.has("content-encoding")) return response;
  if (!COMPRESSIBLE.test(response.headers.get("content-type") ?? "")) return response;
  const length = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(length) && length < MIN_BYTES) return response;
  const encoding = negotiateEncoding(request.headers.get("accept-encoding"));
  if (encoding === null) return response;
  const encoder =
    encoding === "br"
      ? createBrotliCompress({
          params: {
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
            [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          },
        })
      : createGzip();
  const headers = new Headers(response.headers);
  headers.set("content-encoding", encoding);
  headers.delete("content-length");
  headers.append("vary", "accept-encoding");
  return new Response(response.body.pipeThrough(webStream(encoder)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// A zlib encoder as a web TransformStream. Written out rather than taken from
// `Duplex.toWeb`, whose node:stream/web types the DOM's `pipeThrough` does not
// accept; and not `CompressionStream`, which takes no parameters, so its brotli
// is the slow quality 11.
function webStream(encoder: Transform): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      encoder.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      encoder.on("error", (error) => controller.error(error));
    },
    transform(chunk) {
      return new Promise<void>((resolve, reject) => {
        encoder.write(chunk, (error) => (error ? reject(error) : resolve()));
      });
    },
    flush() {
      return new Promise<void>((resolve, reject) => {
        encoder.once("end", resolve);
        encoder.once("error", reject);
        encoder.end();
      });
    },
  });
}
