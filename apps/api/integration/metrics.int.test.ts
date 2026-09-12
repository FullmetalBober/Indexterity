import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_PORT, startApi, stopApi, WEB_ORIGIN } from "./helpers";

// The scrape endpoint against a real Postgres, because the half worth testing is
// the SQL: the queue gauges read graphile_worker's own rows, and nothing in the
// unit suite has that schema.
const PORT = API_PORT + 4;
const METRICS_PORT = 9599;

let server: ChildProcess;
let body = "";

async function scrape(): Promise<string> {
  const res = await fetch(`http://localhost:${METRICS_PORT}/metrics`);
  expect(res.status).toBe(200);
  return await res.text();
}

beforeAll(async () => {
  server = await startApi({ METRICS_ENABLED: "true", METRICS_PORT: String(METRICS_PORT) }, PORT);
  // One sign-up before the scrape, for the mail counter (#526).
  //
  // `emailVerification.sendOnSignUp` makes this the one request that sends mail
  // without an account already existing, and the suite runs with no SMTP_* at
  // all — so it exercises the branch the counter exists for: a send that is a
  // silent no-op, returns false, and is correctly treated as settled. Before
  // #526 nothing anywhere recorded that it happened.
  const signUp = await fetch(`http://localhost:${PORT}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({
      email: `metrics-mail-${Date.now()}@int.test`,
      password: "password12345",
      name: "metrics-mail",
    }),
  });
  expect(signUp.status).toBe(200);
  // Polled rather than slept on: the verification mail is sent DETACHED, so it
  // lands after the response and there is no moment the request can tell us
  // about. A counter that never appears fails the assertion below on the last
  // body rather than timing out with nothing to read.
  //
  // Every other assertion in this file reads the same body: startApi polls
  // /api/health until it answers, so the HTTP counters already have something in
  // them well before the first scrape here.
  for (let attempt = 0; attempt < 40; attempt++) {
    body = await scrape();
    if (body.includes("indexterity_mail_sends_total")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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

  // Mail is the one subsystem whose failure produces no exception, no failed job
  // and no empty panel — a deployment with no SMTP and a week where nothing went
  // wrong look identical from the outside (#526). `disabled` is the branch that
  // was invisible: sendMail no-ops, alertSettled calls it settled because no
  // retry could do better, and the alert is simply gone.
  it("counts a mail this deployment had no transport to send", () => {
    expect(body).toContain("indexterity_mail_sends_total");
    expect(body).toMatch(
      /indexterity_mail_sends_total\{[^}]*outcome="disabled"[^}]*purpose="auth"|indexterity_mail_sends_total\{[^}]*purpose="auth"[^}]*outcome="disabled"/,
    );
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
