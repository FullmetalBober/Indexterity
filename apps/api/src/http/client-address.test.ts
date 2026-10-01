import type { IncomingHttpHeaders } from "node:http";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { believeAddressHeader, believeClientAddressHeader } from "./client-address";

// What a request reaching a Render service carries (#574): the caller's own
// address first, then the Cloudflare edge that Render's proxy appended — and,
// when the caller wrote one, whatever it wrote before both. Cloudflare's own
// header holds the address that actually connected.
const CALLER = "99.61.165.29";
const EDGE = "104.22.17.40";
const FORGED = "6.6.6.6";

describe("believeAddressHeader", () => {
  it("makes the named header's address the whole chain", () => {
    const headers: IncomingHttpHeaders = {
      "x-forwarded-for": `${FORGED}, ${CALLER}, ${EDGE}`,
      "cf-connecting-ip": CALLER,
    };
    believeAddressHeader(headers, "cf-connecting-ip");
    expect(headers["x-forwarded-for"]).toBe(CALLER);
  });

  it("reads an IPv6 address the same way", () => {
    const headers: IncomingHttpHeaders = { "cf-connecting-ip": " 2001:db8::7 " };
    believeAddressHeader(headers, "cf-connecting-ip");
    expect(headers["x-forwarded-for"]).toBe("2001:db8::7");
  });

  // Keeping the chain when the header is absent would hand the decision back to
  // the entry the caller writes. Without it, the request resolves to its peer.
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not an address", "somewhere"],
    ["a list rather than one address", `${FORGED}, ${CALLER}`],
  ])("drops the chain when the header is %s", (_label, value) => {
    const headers: IncomingHttpHeaders = { "x-forwarded-for": `${FORGED}, ${EDGE}` };
    if (value !== undefined) headers["cf-connecting-ip"] = value;
    believeAddressHeader(headers, "cf-connecting-ip");
    expect(headers["x-forwarded-for"]).toBeUndefined();
  });
});

// Against a listening server, because the rewrite is on the http server's own
// `request` event — `inject` never emits it — and because the claim is about
// what FASTIFY then resolves, which only Fastify can answer.
describe("a Fastify server that believes the header", () => {
  const open: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((app) => app.close()));
  });

  async function serve(trustProxy: boolean | string, header: string | null) {
    const lines: string[] = [];
    const app = Fastify({
      trustProxy,
      logger: { level: "info", stream: { write: (line: string) => void lines.push(line) } },
    });
    open.push(app);
    if (header !== null) believeClientAddressHeader(app.server, header);
    app.get("/ip", (request) => ({ ip: request.ip }));
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    const ipFor = async (headers: Record<string, string>): Promise<string> => {
      const response = await fetch(`${origin}/ip`, { headers });
      const body: unknown = await response.json();
      return typeof body === "object" && body !== null && "ip" in body ? String(body.ip) : "";
    };
    return { ipFor, lines };
  }

  const fromRender = {
    "x-forwarded-for": `${FORGED}, ${CALLER}, ${EDGE}`,
    "cf-connecting-ip": CALLER,
  };

  // The premise, pinned so it cannot quietly stop being true: with `true`, the
  // entry the caller wrote is the address it is rate-limited under.
  it("is what `true` alone gets wrong", async () => {
    const { ipFor } = await serve(true, null);
    expect(await ipFor(fromRender)).toBe(FORGED);
  });

  it("resolves the caller from a trusted peer, whatever it wrote", async () => {
    const { ipFor } = await serve("127.0.0.1", "cf-connecting-ip");
    expect(await ipFor(fromRender)).toBe(CALLER);
  });

  // The first thing Fastify does with a request is log it, before any hook has
  // run — so a rewrite in a hook would have logged one address and limited
  // another.
  it("logs the same address it limits", async () => {
    const { ipFor, lines } = await serve("127.0.0.1", "cf-connecting-ip");
    await ipFor(fromRender);
    const incoming = lines.find((line) => line.includes("incoming request"));
    expect(incoming).toContain(`"remoteAddress":"${CALLER}"`);
  });

  // TRUST_PROXY still decides whether the peer is believed at all.
  it("believes nothing from a peer TRUST_PROXY does not trust", async () => {
    const { ipFor } = await serve("10.0.0.0/8", "cf-connecting-ip");
    expect(await ipFor(fromRender)).toBe("127.0.0.1");
  });

  it("falls back to the peer, not the chain, when the header is missing", async () => {
    const { ipFor } = await serve("127.0.0.1", "cf-connecting-ip");
    expect(await ipFor({ "x-forwarded-for": `${FORGED}, ${EDGE}` })).toBe("127.0.0.1");
  });
});
