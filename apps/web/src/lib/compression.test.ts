import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { compressedResponse, negotiateEncoding } from "./compression";

const json = JSON.stringify({
  rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row-${i}` })),
});

function request(acceptEncoding?: string, method = "GET"): Request {
  return new Request("http://dashboard.test/api/clusters", {
    method,
    headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding },
  });
}

function reply(body: string | null, headers: Record<string, string>, status = 200): Response {
  return new Response(body, { status, headers });
}

async function bytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

describe("negotiateEncoding", () => {
  it("prefers brotli, then gzip, and honours a refusal", () => {
    expect(negotiateEncoding("gzip, deflate, br")).toBe("br");
    expect(negotiateEncoding("gzip")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, gzip;q=0.5")).toBe("gzip");
    expect(negotiateEncoding("*")).toBe("br");
    expect(negotiateEncoding("identity")).toBeNull();
    expect(negotiateEncoding(null)).toBeNull();
  });
});

describe("compressedResponse", () => {
  it("compresses JSON for a client that takes brotli, and says so", async () => {
    const out = compressedResponse(
      request("gzip, br"),
      reply(json, { "content-type": "application/json" }),
    );
    expect(out.headers.get("content-encoding")).toBe("br");
    expect(out.headers.get("vary")).toBe("accept-encoding");
    const body = await bytes(out);
    expect(body.length).toBeLessThan(json.length / 4);
    expect(brotliDecompressSync(body).toString()).toBe(json);
  });

  it("falls back to gzip", async () => {
    const out = compressedResponse(
      request("gzip"),
      reply(json, { "content-type": "text/html; charset=utf-8" }),
    );
    expect(out.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(await bytes(out)).toString()).toBe(json);
  });

  // The dashboard's live updates are a text/event-stream, and a compressor holds
  // output back until it has enough of it: the events would sit in its buffer.
  it("never touches an event stream", () => {
    const stream = reply("data: {}\n\n", { "content-type": "text/event-stream" });
    expect(compressedResponse(request("br"), stream)).toBe(stream);
  });

  it("leaves alone what is already encoded, not text, small, empty or HEAD", () => {
    const cases = [
      reply(json, { "content-type": "application/json", "content-encoding": "gzip" }),
      reply(json, { "content-type": "image/png" }),
      reply("{}", { "content-type": "application/json", "content-length": "2" }),
      reply(null, { "content-type": "application/json" }, 204),
    ];
    for (const response of cases)
      expect(compressedResponse(request("br"), response)).toBe(response);
    const head = reply(json, { "content-type": "application/json" });
    expect(compressedResponse(request("br", "HEAD"), head)).toBe(head);
  });

  it("keeps the status and every other header, and drops a length it would falsify", async () => {
    const out = compressedResponse(
      request("br"),
      reply(
        json,
        {
          "content-type": "application/json",
          "content-length": String(json.length),
          "set-cookie": "a=1",
          "x-request-id": "abc",
        },
        201,
      ),
    );
    expect(out.status).toBe(201);
    expect(out.headers.get("content-length")).toBeNull();
    expect(out.headers.get("set-cookie")).toBe("a=1");
    expect(out.headers.get("x-request-id")).toBe("abc");
    expect(brotliDecompressSync(await bytes(out)).toString()).toBe(json);
  });
});
