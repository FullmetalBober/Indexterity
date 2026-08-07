import { ValueType } from "@opentelemetry/api";
import { meter } from "./provider";

// What the dashboard server can answer for, which is not what the api can. The
// api counts every call it serves; these are the numbers that exist nowhere else
// — how long a page took to render, a 500 that never reached the api, and how
// the api looks from this side of the network.
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

// There was a per-server-function instrument here once, and then there were no
// server functions: the browser calls the api directly and the loaders call it
// from this process without an HTTP hop of their own. The note it left behind is
// still the useful one — a seam that only restates the instrument below is not
// worth its framework wiring.

// The api as the dashboard server experiences it, which is now SSR only: a
// browser's calls do not pass through this process at all. It still records the
// hop the api cannot measure, and the case the api can never report — that it
// never answered. A loader read counted on both sides is the point: the
// difference between them is the network.
export const apiRequests = meter.createCounter("indexterity.web.api.requests", {
  description: "Calls to the api by procedure and status (unreachable when it never answered).",
  valueType: ValueType.INT,
});

export const apiDuration = meter.createHistogram("indexterity.web.api.duration.seconds", {
  description: "Time the api took to answer, measured from the dashboard server.",
  unit: "s",
  advice: { explicitBucketBoundaries: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 10] },
});
