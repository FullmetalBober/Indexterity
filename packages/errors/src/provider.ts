// The environment half of error reporting, shared by the api, the worker and
// the dashboard server. Deliberately NOT `Sentry.init` itself: the api runs
// `@sentry/nestjs` and the dashboard `@sentry/tanstackstart-react`, whose option
// surfaces differ, so each app owns its own init and imports the decisions that
// have to be the same everywhere from here.
//
// Off unless SENTRY_DSN is set, exactly like METRICS_ENABLED — and for a
// stronger reason. The chart is installed by operators who are not us: a
// self-hosted install has no business shipping its errors to our account, and
// the DSN is how it points at its own (or at nothing, which is the default).

import { scrub, scrubEvent } from "./scrub.js";

export function sentryDsn(): string | undefined {
  const dsn = process.env.SENTRY_DSN?.trim();
  return dsn === undefined || dsn === "" ? undefined : dsn;
}

export function errorReportingEnabled(): boolean {
  return sentryDsn() !== undefined;
}

// Which deployment an event came from. Separate from NODE_ENV because staging
// and production are both `production` to Node and must not share an issue
// stream — a fixed-in-staging regression should not close the production one.
export function sentryEnvironment(): string {
  const explicit = process.env.SENTRY_ENVIRONMENT?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  return process.env.NODE_ENV ?? "development";
}

export interface SentryDefaultsOptions {
  // What answered: "api" or "web". A tag rather than a separate Sentry project,
  // because everything server-side is one image, one release and one body of
  // code — since #232 the api IS the pipeline, so there is exactly one thing a
  // server-side fault can be tagged as.
  readonly service: string;
  // Ties an issue to the build that produced it. Same version across every
  // package in the repo (scripts/set-version.ts).
  readonly release: string;
}

// Structural rather than imported from @sentry/core, so this package stays free
// of an SDK dependency — the api runs @sentry/nestjs and the dashboard
// @sentry/tanstackstart-react, and neither should be a hard requirement of the
// scrubber's home. Each app's own `Sentry.init` typechecks the result against
// its real option type.
export interface SentryDefaults {
  dsn: string | undefined;
  environment: string;
  release: string;
  initialScope: { tags: { service: string } };
  tracesSampleRate: number;
  sendDefaultPii: boolean;
  dataCollection: {
    userInfo: boolean;
    cookies: boolean;
    // Empty, and typed as such: `never[]` is assignable to the SDK's
    // HttpBodyCollectionTarget[] while `string[]` is not.
    httpBodies: never[];
    stackFrameVariables: boolean;
    databaseQueryData: boolean;
  };
  beforeSend: <T>(event: T) => T;
  beforeSendTransaction: <T>(event: T) => T;
  beforeBreadcrumb: <T>(breadcrumb: T) => T;
}

// dataCollection is set AND the body still arrives; scrubEvent is what removes
// it. Both are kept: the option is the documented control and should start
// working, and the scrub is what holds until it does.

// The options every workload sets identically. Spread into the app's own
// `Sentry.init`, which adds its framework integrations on top.
export function sentryDefaults(options: SentryDefaultsOptions): SentryDefaults {
  return {
    dsn: sentryDsn(),
    environment: sentryEnvironment(),
    release: `indexterity@${options.release}`,
    initialScope: { tags: { service: options.service } },

    // #31 asked for error reporting and nothing else, and tracing here would
    // not be a free extra: D28 put measurement on OpenTelemetry behind a
    // Prometheus exporter and D30 shipped the alert rules that read it, so a
    // second timing pipeline would answer the same questions in a place the
    // chart's alerts cannot see. Turning this up is a decision on its own
    // terms, not a default that arrives with the SDK.
    tracesSampleRate: 0,

    // The SDK's own switch for IP addresses and user identity.
    sendDefaultPii: false,

    // …which does NOT cover what its name suggests, and this was measured rather
    // than reasoned: with sendDefaultPii false, a live 500 on
    // /api/auth/sign-in/email still arrived at the collector carrying
    // `request.data` — the sign-in body, password included. In 10.69 the body,
    // stack locals and database payloads are governed by `dataCollection`, whose
    // defaults collect all of them.
    //
    // Every one of these is a way the connection string leaves by a route the
    // string scrubber cannot see:
    //   httpBodies          POST /clusters carries a customer's connection
    //                       string in its body, and a sign-in carries a password
    //   stackFrameVariables the locals of a collect frame hold the DECRYPTED
    //                       string — sealed at rest is no defence here
    //   databaseQueryData   the clusters table is selected by every job, and
    //                       sealed_dek / sealed_data are columns on it
    //   cookies             the session cookie is a bearer credential
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpBodies: [],
      stackFrameVariables: false,
      databaseQueryData: false,
      // Headers are kept: they are most of what makes a report actionable
      // (method, content type, user agent), the SDK filters known credential
      // headers itself, and `scrub` drops the rest by name.
    },

    // The last thing that runs before an event leaves. Deep-scrubbed on all
    // three hooks: a connection string reaches Sentry through a breadcrumb as
    // easily as through an exception.
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrub,
  };
}
