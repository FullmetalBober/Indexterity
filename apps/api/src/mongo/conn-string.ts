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

// The same credentials and TLS settings, pointed at exactly one member.
//
// `$indexStats` reports for the node that runs it, and the driver sends reads
// to the primary, so per-member usage needs a connection per member. An SRV
// string cannot be retargeted this way (its hosts live in DNS and the scheme
// forbids a port), so it is converted to a plain mongodb:// string.
//
// replicaSet is dropped because it contradicts directConnection, and
// readPreference because a direct connection has one node to choose from.
export function directConnectionTo(value: string, host: string): string {
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
