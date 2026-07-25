import { contract } from "@repo/contracts";
import { getRequest } from "@tanstack/react-start/server";
import { initClient } from "@ts-rest/core";

const baseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

// ts-rest client that forwards the caller's session cookie to the api. Call only
// inside server functions — it reads the current request context.
export function serverApi() {
  const cookie = getRequest()?.headers.get("cookie") ?? "";
  return initClient(contract, { baseUrl, baseHeaders: { cookie } });
}
