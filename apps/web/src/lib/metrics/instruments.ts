import { ValueType } from "@opentelemetry/api";
import { meter } from "./provider";

// What the dashboard server can answer for, which is not what the api can. Every
// call the server functions make lands on the api and is counted there; these are
// the numbers that exist nowhere else — how long a page took to render, a 500
// that never reached the api, and how the api looks from this side of the network.
//
// Names map to Prometheus by replacing `.` with `_` and appending `_total` to
// counters, so `indexterity.web.requests` is scraped as
// `indexterity_web_requests_total`.

// The coarse view: rate and status by kind of request. One counter rather than a
// duration histogram per kind, because an asset request's timing says nothing
// worth a series.
export const requests = meter.createCounter("indexterity.web.requests", {
  description: "Requests served by the dashboard server, by kind and status.",
  valueType: ValueType.INT,
});

// The number that decides whether the dashboard feels slow, per route pattern.
export const documentDuration = meter.createHistogram("indexterity.web.document.duration.seconds", {
  description: "Time to render and stream an HTML document.",
  unit: "s",
  advice: { explicitBucketBoundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
});

// Per server function, named as it is written in the source. A loader that is
// slow because of one of its three api calls shows up here first.
export const serverFnCalls = meter.createCounter("indexterity.web.server_fn.calls", {
  description: "Server function invocations by name and outcome (ok, error).",
  valueType: ValueType.INT,
});

export const serverFnDuration = meter.createHistogram(
  "indexterity.web.server_fn.duration.seconds",
  {
    description: "Time a server function took to answer.",
    unit: "s",
    advice: { explicitBucketBoundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
  },
);

// The api as the dashboard server experiences it — including the hop the api
// cannot measure, and including the case where it never answered at all. The
// same call counted on both sides is the point: the difference between them is
// the network.
export const apiRequests = meter.createCounter("indexterity.web.api.requests", {
  description: "Calls to the api by procedure and status (unreachable when it never answered).",
  valueType: ValueType.INT,
});

export const apiDuration = meter.createHistogram("indexterity.web.api.duration.seconds", {
  description: "Time the api took to answer, measured from the dashboard server.",
  unit: "s",
  advice: { explicitBucketBoundaries: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 10] },
});
