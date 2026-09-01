import { describe, expect, it } from "vitest";
import { isSecretKey, REDACTED, scrub, scrubEvent, scrubString } from "./scrub.js";

// The string this whole package exists to stop. Realistic on purpose: a
// replica-set URI with credentials, an auth database and options, because a
// pattern that only matches `mongodb://host` passes a test and leaks in
// production.
const CONNECTION_STRING =
  "mongodb+srv://idx_a91f:S3cr3t%2Fpw@cluster0.ab12c.mongodb.net/admin?retryWrites=true&w=majority";

describe("scrubString", () => {
  it("removes a mongodb+srv uri whole, hosts included", () => {
    const scrubbed = scrubString(`connect ECONNREFUSED ${CONNECTION_STRING}`);
    expect(scrubbed).toBe(`connect ECONNREFUSED ${REDACTED}`);
    expect(scrubbed).not.toContain("cluster0.ab12c.mongodb.net");
    expect(scrubbed).not.toContain("S3cr3t");
  });

  it("removes a plain mongodb uri and a postgres uri", () => {
    expect(scrubString("mongodb://user:pw@10.0.0.4:27017/?tls=true")).toBe(REDACTED);
    expect(scrubString("postgresql://app:pw@db.internal:5432/indexterity")).toBe(REDACTED);
    expect(scrubString("postgres://app:pw@db.internal:5432/indexterity")).toBe(REDACTED);
  });

  it("finds one inside driver prose rather than only at the start", () => {
    // The shape MongoServerSelectionError actually produces.
    const message = `Server selection timed out after 30000 ms for ${CONNECTION_STRING}, topology ReplicaSetNoPrimary`;
    const scrubbed = scrubString(message);
    expect(scrubbed).toContain("Server selection timed out");
    expect(scrubbed).toContain("topology ReplicaSetNoPrimary");
    expect(scrubbed).not.toContain("mongodb+srv://");
  });

  it("removes every occurrence, not just the first", () => {
    const scrubbed = scrubString(`${CONNECTION_STRING} then ${CONNECTION_STRING}`);
    expect(scrubbed).toBe(`${REDACTED} then ${REDACTED}`);
  });

  it("keeps the scheme but drops the credentials of any other uri", () => {
    expect(scrubString("smtp://mailer:hunter2@smtp.example.com:587")).toBe(
      `smtp://${REDACTED}@smtp.example.com:587`,
    );
    expect(scrubString("https://token@hooks.example.com/x")).toBe(
      `https://${REDACTED}@hooks.example.com/x`,
    );
  });

  // Regression: a live 500 on /api/auth/sign-in/email delivered the sign-in body
  // as `request.data`, a JSON-encoded STRING, so `password` was never a key the
  // walker could match and the password reached the collector.
  it("removes a secret encoded inside a json string", () => {
    const body = '{"email":"a@example.com","password":"whatever12345"}';
    const scrubbed = scrubString(body);
    expect(scrubbed).not.toContain("whatever12345");
    expect(scrubbed).toContain("a@example.com");
    expect(scrubbed).toBe(`{"email":"a@example.com","password":"${REDACTED}"}`);
  });

  it("removes a json-encoded connection string and sealed columns", () => {
    const body = `{"name":"prod","connectionString":"${CONNECTION_STRING}","sealed_dek":"AAAA"}`;
    const scrubbed = scrubString(body);
    expect(scrubbed).not.toContain("S3cr3t");
    expect(scrubbed).not.toContain("AAAA");
    expect(scrubbed).toContain('"name":"prod"');
  });

  it("survives an escaped quote inside the secret", () => {
    expect(scrubString('{"password":"a\\"b","keep":1}')).toBe(
      `{"password":"${REDACTED}","keep":1}`,
    );
  });

  it("leaves an ordinary url alone — over-redacting hides the fault", () => {
    expect(scrubString("GET https://api.example.com/v1/clusters failed with 502")).toBe(
      "GET https://api.example.com/v1/clusters failed with 502",
    );
  });
});

describe("isSecretKey", () => {
  it("matches the fastify logger's redact list, however the key is spelled", () => {
    for (const key of ["authorization", "Authorization", "cookie", "set-cookie", "setCookie"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it("matches secrets that no uri pattern would catch", () => {
    for (const key of ["MASTER_KEY", "BETTER_AUTH_SECRET", "password", "totpSecret"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it("does not match the fields that make an event worth reading", () => {
    for (const key of ["message", "clusterId", "taskIdentifier", "requestId", "url"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe("scrub", () => {
  // Every field a Sentry event carries a string in, each seeded with the one
  // string that must never leave. This is the test that fails when the SDK
  // grows a field and a per-field scrubber would have missed it.
  it("reaches every field of a realistic event", () => {
    const event = {
      event_id: "abc123",
      message: `collect failed for ${CONNECTION_STRING}`,
      exception: {
        values: [
          {
            type: "MongoServerSelectionError",
            value: `Server selection timed out for ${CONNECTION_STRING}`,
            stacktrace: {
              frames: [{ filename: "jobs/collect.ts", vars: { uri: CONNECTION_STRING } }],
            },
          },
        ],
      },
      breadcrumbs: [
        { message: `dialing ${CONNECTION_STRING}`, data: { connection_string: CONNECTION_STRING } },
      ],
      request: {
        url: "https://app.example.com/api/clusters",
        headers: { cookie: "session=abc", authorization: "Bearer x" },
        data: { connectionString: CONNECTION_STRING },
      },
      contexts: { cluster: { note: `stored ${CONNECTION_STRING}` } },
      extra: { attempted: [CONNECTION_STRING] },
      tags: { service: "worker", task: "collect" },
    };

    const scrubbed = scrub(event);
    const serialised = JSON.stringify(scrubbed);

    expect(serialised).not.toContain("mongodb+srv://");
    expect(serialised).not.toContain("S3cr3t");
    expect(serialised).not.toContain("cluster0.ab12c.mongodb.net");
    expect(serialised).not.toContain("session=abc");
    expect(serialised).not.toContain("Bearer x");

    // …and the event is still worth having afterwards.
    expect(scrubbed.event_id).toBe("abc123");
    expect(scrubbed.exception.values[0]?.type).toBe("MongoServerSelectionError");
    expect(scrubbed.exception.values[0]?.value).toContain("Server selection timed out");
    expect(scrubbed.request.url).toBe("https://app.example.com/api/clusters");
    expect(scrubbed.tags).toEqual({ service: "worker", task: "collect" });
  });

  it("does not mutate the event it was given", () => {
    const event = { message: CONNECTION_STRING };
    scrub(event);
    expect(event.message).toBe(CONNECTION_STRING);
  });

  it("passes non-strings through untouched", () => {
    const event = { count: 3, ok: false, missing: null, when: undefined };
    expect(scrub(event)).toEqual(event);
  });

  // The copy is `{ ...event }`, which is what makes the return type checked
  // rather than asserted — and spreading an ARRAY that way would hand back an
  // object keyed by index. No hook passes one, so it is refused loudly instead
  // of corrupted quietly. Nested arrays are walked, which the case above covers.
  it("refuses a top-level array rather than returning it keyed by index", () => {
    expect(() => scrub([CONNECTION_STRING])).toThrow(TypeError);
  });

  // Every key survives, which is the property the old `as T` only claimed: the
  // copy starts from the event rather than from an empty object, so a field
  // cannot go missing on the way through.
  it("keeps every key it was given", () => {
    const event = { message: CONNECTION_STRING, level: "error", tags: { a: "b" } };
    expect(Object.keys(scrub(event))).toEqual(["message", "level", "tags"]);
  });

  it("survives a cycle rather than throwing on the way to the wire", () => {
    const event: Record<string, unknown> = { message: CONNECTION_STRING };
    event.self = event;
    expect(() => scrub(event)).not.toThrow();
    expect(scrub(event).message).toBe(REDACTED);
  });
});

describe("scrubEvent", () => {
  // Regression, from a live 500 against the running stack: the SDK attaches the
  // request body even with dataCollection.httpBodies set to [], so the body has
  // to be removed here or not at all.
  it("drops the request body whole", () => {
    const event = {
      request: {
        url: "https://app.example.com/api/clusters",
        method: "POST",
        data: `{"name":"prod","connectionString":"${CONNECTION_STRING}"}`,
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.request.data).toBe(REDACTED);
    // …and keeps what makes the report worth reading.
    expect(scrubbed.request.url).toBe("https://app.example.com/api/clusters");
    expect(scrubbed.request.method).toBe("POST");
  });

  it("still scrubs everything scrub does", () => {
    const scrubbed = scrubEvent({ message: `failed for ${CONNECTION_STRING}` });
    expect(scrubbed.message).toBe(`failed for ${REDACTED}`);
  });

  it("leaves an event with no request alone", () => {
    expect(scrubEvent({ message: "plain" })).toEqual({ message: "plain" });
    expect(scrubEvent({ request: { url: "https://x.example.com" } })).toEqual({
      request: { url: "https://x.example.com" },
    });
  });
});
