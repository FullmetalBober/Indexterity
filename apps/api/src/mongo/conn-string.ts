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
