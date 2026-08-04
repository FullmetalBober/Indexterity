import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PORT, startApi, stopApi } from "./helpers";

// The scrape endpoint against a real Postgres, because the half worth testing is
// the SQL: the queue gauges read graphile_worker's own rows, and nothing in the
// unit suite has that schema.
const PORT = API_PORT + 4;
const METRICS_PORT = 9599;

let server: ChildProcess;
let body = "";

beforeAll(async () => {
  server = await startApi({ METRICS_ENABLED: "true", METRICS_PORT: String(METRICS_PORT) }, PORT);
  // startApi polls /api/health until it answers, so the HTTP counters already
  // have something in them by the time we scrape.
  const res = await fetch(`http://localhost:${METRICS_PORT}/metrics`);
  expect(res.status).toBe(200);
  body = await res.text();
}, 120_000);

afterAll(async () => {
  await stopApi(server);
});

describe("the metrics endpoint", () => {
  it("serves what the api itself did", () => {
    expect(body).toContain("indexterity_http_requests_total");
    expect(body).toMatch(/indexterity_http_requests_total\{[^}]*route="\/api\/health"/);
    expect(body).toContain("indexterity_http_request_duration_seconds_bucket");
  });

  // Observed last of the four control-plane queries, so its presence means every
  // one of them ran. The scrape-error counter says the same thing from the other
  // side: it only exists once something has failed.
  it("reads the job queue out of the graphile_worker schema", () => {
    expect(body).toContain("indexterity_jobs_oldest_queued_age_seconds");
    expect(body).not.toContain("indexterity_metrics_scrape_errors_total");
  });

  it("names the build, so a dashboard can say which version is running", () => {
    expect(body).toMatch(/target_info\{[^}]*service_name="indexterity"/);
    expect(body).toMatch(/target_info\{[^}]*service_version="/);
  });

  it("answers nothing but /metrics", async () => {
    const res = await fetch(`http://localhost:${METRICS_PORT}/`);
    expect(res.status).toBe(404);
  });

  // The whole reason it is a second port: index counts, cluster counts and queue
  // depth are operator information, and the api port is the one an ingress
  // publishes on the dashboard's origin.
  it("is not reachable on the api port", async () => {
    const res = await fetch(`http://localhost:${PORT}/metrics`);
    expect(res.status).toBe(404);
    const prefixed = await fetch(`http://localhost:${PORT}/api/metrics`);
    expect(prefixed.status).toBe(404);
  });
});
