import { describe, expect, it, vi } from "vitest";
import { DnsError, decodeAnswers, encodeQuery, resolveThroughTunnel } from "./dns";

// Wire-format tests. A resolver that mis-parses a compression pointer does not
// crash — it returns a plausible wrong address, and the control plane then
// dials it. That is the failure this file exists to make impossible.

const answer = (options: {
  id: number;
  rcode?: number;
  questions?: number;
  records?: { type: number; data: Buffer; pointer?: boolean }[];
}) => {
  const { id, rcode = 0, questions = 1, records = [] } = options;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8180 | rcode, 2);
  header.writeUInt16BE(questions, 4);
  header.writeUInt16BE(records.length, 6);

  // One question for "db.internal", which the answers then point back at.
  const question = Buffer.concat([
    Buffer.from([2]),
    Buffer.from("db"),
    Buffer.from([8]),
    Buffer.from("internal"),
    Buffer.from([0]),
    Buffer.from([0, 1, 0, 1]),
  ]);

  const bodies = records.map((record) => {
    // Real resolvers compress the owner name to a pointer at offset 12.
    const name = record.pointer === false ? Buffer.from([0]) : Buffer.from([0xc0, 0x0c]);
    const head = Buffer.alloc(10);
    head.writeUInt16BE(record.type, 0);
    head.writeUInt16BE(1, 2);
    head.writeUInt32BE(60, 4);
    head.writeUInt16BE(record.data.length, 8);
    return Buffer.concat([name, head, record.data]);
  });

  return Buffer.concat([header, question, ...bodies]);
};

describe("encodeQuery", () => {
  it("length-prefixes each label and terminates with a zero", () => {
    const query = encodeQuery("db.internal", 1, 0x1234);
    expect(query.readUInt16BE(0)).toBe(0x1234);
    expect(query.readUInt16BE(2)).toBe(0x0100); // recursion desired
    expect(query.readUInt16BE(4)).toBe(1);
    expect(query.subarray(12).toString("hex")).toBe(
      `02${Buffer.from("db").toString("hex")}08${Buffer.from("internal").toString("hex")}00` +
        "00010001",
    );
  });

  it("tolerates a trailing dot, which a connection string may carry", () => {
    expect(encodeQuery("db.internal.", 1, 1)).toEqual(encodeQuery("db.internal", 1, 1));
  });

  it("refuses an empty or oversized label", () => {
    expect(() => encodeQuery("db..internal", 1, 1)).toThrow(DnsError);
    expect(() => encodeQuery(`${"x".repeat(64)}.internal`, 1, 1)).toThrow(DnsError);
  });
});

describe("decodeAnswers", () => {
  it("reads an A record behind a compression pointer", () => {
    const message = answer({ id: 7, records: [{ type: 1, data: Buffer.from([10, 0, 0, 5]) }] });
    expect(decodeAnswers(message, 7)).toEqual(["10.0.0.5"]);
  });

  it("reads an AAAA record", () => {
    const data = Buffer.from("fd0000000000000000000000000000ff", "hex");
    const message = answer({ id: 8, records: [{ type: 28, data }] });
    expect(decodeAnswers(message, 8)).toEqual(["fd00:0:0:0:0:0:0:ff"]);
  });

  it("returns every address when a name has several", () => {
    const message = answer({
      id: 9,
      records: [
        { type: 1, data: Buffer.from([10, 0, 0, 1]) },
        { type: 1, data: Buffer.from([10, 0, 0, 2]) },
      ],
    });
    expect(decodeAnswers(message, 9)).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("skips a record type it was not asked about, rather than mis-reading it", () => {
    const message = answer({
      id: 10,
      records: [
        { type: 5, data: Buffer.from([0]) }, // CNAME
        { type: 1, data: Buffer.from([10, 0, 0, 3]) },
      ],
    });
    expect(decodeAnswers(message, 10)).toEqual(["10.0.0.3"]);
  });

  // NXDOMAIN is an answer, not a fault: the name does not exist inside the
  // tunnel, which should read as "unreachable" and not as "DNS broke".
  it("treats NXDOMAIN as an empty result", () => {
    expect(decodeAnswers(answer({ id: 11, rcode: 3 }), 11)).toEqual([]);
  });

  it("refuses a reply whose id is not the query's, which is the off-path forgery", () => {
    expect(() => decodeAnswers(answer({ id: 12 }), 99)).toThrow(/id does not match/);
  });

  it("refuses any other rcode rather than reporting no addresses", () => {
    expect(() => decodeAnswers(answer({ id: 13, rcode: 2 }), 13)).toThrow(/rcode 2/);
  });

  it("refuses a header-only truncation", () => {
    expect(() => decodeAnswers(Buffer.alloc(4), 1)).toThrow(/shorter than a header/);
  });

  it("refuses a compression pointer that loops instead of hanging", () => {
    const message = Buffer.alloc(20);
    message.writeUInt16BE(1, 0);
    message.writeUInt16BE(0x8180, 2);
    message.writeUInt16BE(1, 4);
    // A question whose name points at itself.
    message.writeUInt8(0xc0, 12);
    message.writeUInt8(12, 13);
    expect(() => decodeAnswers(message, 1)).toThrow(/loop/);
  });
});

describe("resolveThroughTunnel", () => {
  it("returns an IP literal without asking anyone", async () => {
    const transport = vi.fn();
    expect(await resolveThroughTunnel("10.0.0.9", [], transport)).toEqual(["10.0.0.9"]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a name when the config carries no DNS, and says why", async () => {
    await expect(resolveThroughTunnel("db.internal", [], vi.fn())).rejects.toThrow(
      /carries no DNS/,
    );
  });

  it("asks the tunnel's resolver and returns what it answers", async () => {
    const transport = vi.fn(async (query: Buffer) =>
      answer({
        id: query.readUInt16BE(0),
        records:
          query.readUInt16BE(query.length - 4) === 1
            ? [{ type: 1, data: Buffer.from([10, 0, 0, 7]) }]
            : [],
      }),
    );
    expect(await resolveThroughTunnel("db.internal", ["10.9.0.1"], transport)).toEqual([
      "10.0.0.7",
    ]);
    // Both families asked for: a host with only AAAA is not an error.
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("falls through to a second resolver when the first is down", async () => {
    const transport = vi.fn(async (query: Buffer, server: string) => {
      if (server === "10.9.0.1") throw new Error("no route");
      return answer({
        id: query.readUInt16BE(0),
        records: [{ type: 1, data: Buffer.from([10, 0, 0, 8]) }],
      });
    });
    expect(await resolveThroughTunnel("db.internal", ["10.9.0.1", "10.9.0.2"], transport)).toEqual([
      "10.0.0.8",
      "10.0.0.8",
    ]);
  });

  it("times out rather than hanging on a resolver that never answers", async () => {
    const transport = vi.fn(() => new Promise<Buffer>(() => {}));
    await expect(resolveThroughTunnel("db.internal", ["10.9.0.1"], transport, 20)).rejects.toThrow(
      /no answer in 20ms/,
    );
  });
});
