import { createHmac } from "node:crypto";
import { test as base, expect, type Page } from "@playwright/test";

// `test` for this suite, not @playwright/test's — every spec imports it from
// here so that one fixture applies to all of them.
//
// The fixture is the Content-Security-Policy's only honest test. The header is
// a nonce the SSR scripts have to carry (src/lib/security-headers.ts), and the
// way it fails is not an exception anyone can catch: the browser refuses the
// hydration script and the page renders, sits there, and never becomes
// interactive. Most of what these specs do would then fail anyway — but on a
// button that "does nothing", which reads as a slow app rather than a broken
// header. So the refusal itself is the assertion, and it is made on EVERY test
// rather than on a page or two.
export const test = base.extend<{ cspRefusals: string[] }>({
  cspRefusals: [
    async ({ page }, use) => {
      const refusals = new Set<string>();
      // The `securitypolicyviolation` event rather than the console message,
      // because it names WHERE. The console only says a policy was violated, and
      // the answer to that is always "which of the dozen things on this page?" —
      // the event carries the directive and the source position that did it,
      // which is what a fix starts from. Both times this fired for real, that
      // position is what identified the library.
      //
      // Playwright injects this through CDP, before any page script and outside
      // the policy's reach, so the listener cannot itself be refused.
      await page.exposeFunction("__cspRefusal", (detail: string) => void refusals.add(detail));
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          const where = event.sourceFile
            ? `${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`
            : event.documentURI;
          const report = (window as unknown as { __cspRefusal: (d: string) => void }).__cspRefusal;
          report(`${event.effectiveDirective} refused ${event.blockedURI} at ${where}`);
        });
      });
      await use([...refusals]);
      expect([...refusals], "the browser refused something the policy should have allowed").toEqual(
        [],
      );
    },
    { auto: true },
  ],
});

// Every account this suite creates carries this prefix, so the teardown can
// find its own rows and nothing else's — the dev postgres is shared with the
// api's integration suite and with whatever is being developed at the time.
export const E2E_EMAIL_PREFIX = "e2e-";

// Organizations are made on purpose now rather than conjured behind the first
// request, so the suite makes its own — and they need a prefix for the same
// reason the addresses do. `organizations` has no foreign key to `user`, so
// deleting the accounts does NOT take them: the teardown removes these by name.
export const E2E_ORG_PREFIX = "e2e-org-";

export const MONGO_URL = process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017";

// An auth-enabled mongod whose user can create users, when the run has one.
//
// The MONGO_URL above deliberately has authentication disabled, which is the one
// state where the scoped-user offer can never appear: every privilege is granted
// and a dedicated user cannot be enforced, so `canProvision` is false whatever
// the code does. That is why the provisioning path had no e2e coverage while the
// fixture's `Connect` / `Use these credentials as-is` branch looked like it did
// (#86) — the second half never ran.
//
// Empty means the tests that need it skip rather than fail. CI runs a second
// mongo service with a root user for exactly this; locally:
//
//   podman run -d --rm --name mongo-auth -p 27018:27017 \
//     -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=secret \
//     docker.io/library/mongo:8
//   export MONGO_ADMIN_URL=mongodb://root:secret@127.0.0.1:27018
export const MONGO_ADMIN_URL = process.env.MONGO_ADMIN_URL ?? "";

// The name the api gives the user it provisions — one fixed name on every
// engine, not a random one per provision, which is what makes a second provision
// against the same server a refusal rather than a second user
// (`SCOPED_USERNAME` in apps/api/src/mongo/provision.ts). Repeated as a literal
// here for the same reason the connect form repeats it: the e2e suite is a
// consumer of the api like any other, and importing across the workspace
// boundary would pull the driver and the whole module in behind it.
export const SCOPED_USERNAME = "indexterity";

let counter = 0;

// Unique per test AND per run: postgres keeps rows between runs, and a second
// run reusing an address would fail on the unique constraint rather than on
// anything the test is about.
export function uniqueEmail(label: string): string {
  counter += 1;
  return `${E2E_EMAIL_PREFIX}${label}-${Date.now()}-${counter}@example.test`;
}

export const PASSWORD = "e2e-Passw0rd!";

// Create an account through the UI, make it an organization, and wait for the
// app. Sign-up is the only way in — there is no seeded user, on purpose: an
// account that the tests create is an account the app can actually create.
//
// The org step is not scaffolding. A fresh account belongs to nothing now, and
// the create screen is the first thing it sees; a fixture that skipped it would
// be testing a state the product does not have.
export async function signUpAndLandOnDashboard(page: Page, email: string): Promise<string> {
  await page.goto("/app");
  await page.getByRole("button", { name: "Need an account? Sign up" }).click();
  // exact, because getByLabel does a case-insensitive SUBSTRING match and the
  // connect form now carries an "Allow a mismatched hostname" checkbox — which
  // contains "name" and made every "Name" locator ambiguous.
  await page.getByLabel("Name", { exact: true }).fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  return createOrgAndLandOnDashboard(page);
}

// Fill in the create-org screen and wait for what is behind it. Named after the
// account so two accounts in one test never share a name on screen.
//
// What is behind it is the connect page, not a dashboard: an org with no
// clusters has nothing to show, so /app sends it to the one thing there is to
// do. Waiting on that heading is also what proves the redirect happened.
export async function createOrgAndLandOnDashboard(page: Page): Promise<string> {
  counter += 1;
  const name = `${E2E_ORG_PREFIX}${Date.now()}-${counter}`;
  // Longer than the default, because this is the first thing rendered after a
  // sign-up and what it is really waiting on is scrypt: hashing a password takes
  // ~2s on an idle machine and several times that with a browser, a web server,
  // an api and postgres competing for the same cores. Ten seconds is a coin
  // flip near the end of a full run, and a flaky suite is one nobody reads.
  await expect(page.getByText("Make an organization")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Organization name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect a cluster" })).toBeVisible();
  return name;
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/app");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

// Open the connect page from the rail, wherever the test happens to be. It is
// one link from every page now — which is the point of #81: connecting the
// second cluster used to mean finding a form under the first one's numbers.
export async function openConnectForm(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Connect a cluster" }).click();
  await expect(page.getByLabel("Connection string")).toBeVisible();
}

// Paste the real mongo, run the preflight, and connect. Leaves the page on the
// new cluster's own overview.
export async function connectCluster(page: Page, name: string): Promise<void> {
  await openConnectForm(page);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Connection string").fill(MONGO_URL);
  await page.getByRole("button", { name: "Check access" }).click();
  // The preflight has answered when a connect action appears.
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  const asIs = page.getByRole("button", { name: "Use these credentials as-is" });
  await expect(connect.or(asIs)).toBeVisible();
  await ((await connect.isVisible()) ? connect : asIs).click();
  // The cluster's own page, which is the heading rather than a name in a bar.
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

// The cluster's policy and connection live behind its Settings tab now, not at
// the bottom of the overview.
export async function openClusterSettings(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Cluster" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page.getByLabel("Observe window (days)")).toBeVisible();
}

// Enough RFC 6238 to play the authenticator app (better-auth's defaults:
// SHA-1, 6 digits, 30s period). The suite reads the manual-entry key off the
// enrolment screen exactly as a person typing it into a phone would.
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(encoded: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of encoded.replace(/=+$/, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(secret: string, at: number = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
