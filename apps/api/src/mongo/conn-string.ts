import ConnectionString from "mongodb-connection-string-url";

// Every host a string would dial, plus whether it is an SRV seed (whose real
// targets live in DNS). Feeds the network guard — see engine/net-guard.ts.
export function mongoHosts(value: string): { hosts: string[]; isSrv: boolean } {
  try {
    const parsed = new ConnectionString(value);
    return { hosts: [...parsed.hosts], isSrv: parsed.isSRV };
  } catch {
    return { hosts: [], isSrv: false };
  }
}

// What the driver actually connected with, which for an SRV string is not what
// the string says. Read off the live client — see MongoConnection.resolved().
export interface ResolvedConnection {
  readonly tls: boolean;
  // null when the cluster takes no credentials at all.
  readonly authSource: string | null;
}

// The same credentials and TLS settings, pointed at exactly one member.
//
// `$indexStats` reports for the node that runs it, and the driver sends reads
// to the primary, so per-member usage needs a connection per member. An SRV
// string cannot be retargeted this way (its hosts live in DNS and the scheme
// forbids a port), so it is converted to a plain mongodb:// string.
//
// replicaSet is dropped because it contradicts directConnection, and
// readPreference because a direct connection has one node to choose from.
//
// `resolved` is not optional in spirit, only in signature, and only because the
// scheme conversion above silently discards two things that live OUTSIDE the
// text of an SRV string:
//
//   - **tls.** `mongodb+srv://` defaults it to true. `mongodb://` defaults it to
//     false. Rewriting the scheme therefore turns a TLS connection into a
//     plaintext one, and Atlas — which hands out SRV strings by default — listens
//     TLS-only. The handshake is refused.
//   - **authSource.** An SRV deployment publishes it in a DNS TXT record, which
//     the driver reads at connect and merges into its credentials. A plain string
//     performs no SRV lookup, so authSource falls back to the database in the
//     path and SCRAM authenticates against the wrong one.
//
// Both failures land in the `catch` in members.ts, which exists for a member that
// is legitimately down, so on every SRV cluster the per-member fan-out opened
// zero connections and said nothing. Measured against a requireTLS + --auth
// mongod: as-built refused at the handshake, +tls got "Authentication failed",
// +tls +authSource connected. Two breakages in series, which is why fixing one
// looked like it had not helped.
//
// Only filled in when the string does not already say. An explicit `tls=false`
// or `authSource=` in the customer's own string is a statement, and `resolved`
// carries the same value anyway — the driver's resolution is what produced it.
export function directConnectionTo(
  value: string,
  host: string,
  resolved?: ResolvedConnection,
): string {
  const parsed = new ConnectionString(value);
  const direct = new ConnectionString(
    parsed.isSRV ? value.replace(/^mongodb\+srv:\/\//, "mongodb://") : value,
    { looseValidation: true },
  );
  direct.protocol = "mongodb:";
  direct.hosts = [host];
  direct.searchParams.delete("replicaSet");
  direct.searchParams.delete("readPreference");
  direct.searchParams.set("directConnection", "true");
  if (parsed.isSRV && resolved !== undefined) {
    // `ssl` is the driver's alias for `tls`; either one present means the string
    // has already answered the question.
    if (!direct.searchParams.has("tls") && !direct.searchParams.has("ssl")) {
      direct.searchParams.set("tls", String(resolved.tls));
    }
    if (resolved.authSource !== null && !direct.searchParams.has("authSource")) {
      direct.searchParams.set("authSource", resolved.authSource);
    }
  }
  return direct.toString();
}

// Scheme guard: the control plane dials whatever createCluster stores, so only
// mongodb schemes with a host are accepted — never http/file/gopher/…. The
// address itself is vetted separately by engine/net-guard.ts.
//
// Parsed by the driver's own parser rather than WHATWG `new URL`, which cannot
// represent the comma-separated host list of a replica-set string
// (mongodb://a:27017,b:27017/db) and rejected every one of them.
export function isMongoConnString(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  let parsed: ConnectionString;
  try {
    parsed = new ConnectionString(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "mongodb:" && parsed.protocol !== "mongodb+srv:") return false;
  return parsed.hosts.length > 0;
}
