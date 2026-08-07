import { apiDuration, apiRequests } from "./instruments";

// The api as the dashboard server experiences it.
//
// The api counts every request it serves, so this is not a second copy of that
// number — it is the same call measured from the other end of the network, plus
// the case the api can never report: it did not answer. A gap between the two
// durations is the hop and the serialization; a call that appears here and not
// there never arrived.
//
// The label is the oRPC procedure path (`listClusters`, `getRoi`), which is
// bounded by the contract, so no URL ever becomes a series.
export function instrumentedFetch(path: readonly string[], request: Request): Promise<Response> {
  const procedure = path.join(".");
  const started = performance.now();
  return globalThis
    .fetch(request)
    .then((response) => {
      apiRequests.add(1, { procedure, status: response.status });
      apiDuration.record((performance.now() - started) / 1000, { procedure });
      return response;
    })
    .catch((error: unknown) => {
      // No status, because there was no response — a refused connection, DNS, a
      // timeout. "unreachable" is the honest label and the one worth alerting on.
      apiRequests.add(1, { procedure, status: "unreachable" });
      apiDuration.record((performance.now() - started) / 1000, { procedure });
      throw error;
    });
}
