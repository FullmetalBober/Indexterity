import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { orpcCode } from "../errors/message";
import { type RequestHeaders, requireSession, requireUserId, sessionCookiesFor } from "./session";

const getSession = vi.hoisted(() => vi.fn());
vi.mock("./index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./index")>()),
  auth: { api: { getSession } },
}));

// Only `headers` is read from the request, and identity is what the cache is
// keyed on — two calls to this are two requests.
// A complete RequestHeaders — the one member this module reads.
function request(): RequestHeaders {
  return { headers: { cookie: "better-auth.session_token=tok" } };
}

const SIGNED_IN_AT = new Date("2026-08-01T10:00:00Z");

function authed(
  activeOrganizationId: string | null = null,
  cookies: string[] = [],
  // A Date when postgres answered, an ISO string when the cookie cache did —
  // resolveSession has to take both (#52 measures freshness off this).
  createdAt: Date | string = SIGNED_IN_AT,
) {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return {
    headers,
    response: { user: { id: "user-1" }, session: { activeOrganizationId, createdAt } },
  };
}

beforeEach(() => {
  getSession.mockReset();
});

describe("requireSession", () => {
  it("resolves once per request, however many times it is asked", async () => {
    getSession.mockResolvedValue(authed("org-1"));
    const req = request();
    const first = await requireSession(req);
    const second = await requireUserId(req);
    expect(first).toEqual({
      userId: "user-1",
      activeOrgId: "org-1",
      signedInAt: SIGNED_IN_AT,
      twoFactorEnabled: false,
    });
    expect(second).toBe("user-1");
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("shares one resolution between concurrent asks, not just later ones", async () => {
    let release: (value: ReturnType<typeof authed>) => void = () => {};
    getSession.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const req = request();
    const both = Promise.all([requireSession(req), requireSession(req)]);
    release(authed());
    const [first, second] = await both;
    expect(first.userId).toBe("user-1");
    expect(second.userId).toBe("user-1");
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("does not leak one request's caller into another", async () => {
    getSession.mockResolvedValue(authed());
    await requireSession(request());
    await requireSession(request());
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("401s without a session, and the cached answer stays 401", async () => {
    getSession.mockResolvedValue({ headers: new Headers(), response: null });
    const req = request();
    for (let i = 0; i < 2; i++) {
      const refused = await requireSession(req).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(ORPCError);
      expect(orpcCode(refused)).toBe("UNAUTHORIZED");
    }
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("maps a session that never switched org to a null activeOrgId", async () => {
    getSession.mockResolvedValue(authed(null));
    expect((await requireSession(request())).activeOrgId).toBeNull();
  });

  it("reads signedInAt off a cookie-cache answer, where the date is a string", async () => {
    getSession.mockResolvedValue(authed(null, [], SIGNED_IN_AT.toISOString()));
    expect((await requireSession(request())).signedInAt).toEqual(SIGNED_IN_AT);
  });
});

describe("sessionCookiesFor", () => {
  it("is empty when nothing asked for the session", () => {
    expect(sessionCookiesFor(request())).toEqual([]);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("hands back the refreshed session-cache cookies after a resolution", async () => {
    const refreshed = "better-auth.session_data=payload; Max-Age=300; Path=/";
    getSession.mockResolvedValue(authed("org-1", [refreshed]));
    const req = request();
    await requireSession(req);
    expect(sessionCookiesFor(req)).toEqual([refreshed]);
  });

  it("stays quiet when the resolution itself failed", async () => {
    getSession.mockRejectedValue(new Error("postgres is gone"));
    const req = request();
    await expect(requireSession(req)).rejects.toThrow("postgres is gone");
    expect(sessionCookiesFor(req)).toEqual([]);
  });
});
