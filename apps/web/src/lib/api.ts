import { contract } from "@repo/contracts";
import { initClient } from "@ts-rest/core";

// Typed client built from the same contract the api implements — end-to-end types.
export const api = initClient(contract, {
  baseUrl: import.meta.env.VITE_API_URL ?? "http://localhost:3001",
  baseHeaders: {},
});
