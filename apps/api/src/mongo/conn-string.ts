// SSRF guard: the control plane dials whatever createCluster stores, so only
// mongodb schemes with a host are accepted — never http/file/gopher/….
export function isMongoConnString(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "mongodb:" && url.protocol !== "mongodb+srv:") return false;
  return url.hostname.length > 0 || url.pathname.startsWith("//");
}
