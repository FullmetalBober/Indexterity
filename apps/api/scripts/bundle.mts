// Bundle each of the api's entrypoints into one file, after swc has compiled it
// (#567, #580).
//
// swc writes one file per source file, and node resolves each of them and every
// package they import, one `require` at a time. On a full CPU that is most of a
// five-second boot; on the 0.1 CPU of a free hosting tier it is most of a minute,
// and the host waits for `/api/health` before it sends a request. A CPU profile
// of the boot put 2.9 of its 4.2 seconds in node's module loader, and almost
// none in compilation: resolving paths, stat calls, `package.json` scope lookups
// and reading files. One file removes nearly all of that. Measured on the 0.25.0
// image, api alone: 5.3 s to 2.4 s at one CPU, 37.8 s to 16.9 s at 0.1.
//
// Each bundle REPLACES its entrypoint in dist, so everything that runs one runs
// the bundle: the images, e2e and the chart's kind installs start dist/main.js,
// the chart's migrate Job runs dist/migrate.js, and the integration suite runs
// both from a copy outside the repository (integration/global-setup.ts). The
// CLIs (migrate.js, rotate-key.js, set-plan.js) start once and exit, so their
// boot was never the reason to bundle them; the image is (#580, D182). With every
// entrypoint bundled, nothing at run time resolves a module from node_modules, so
// the images ship none — it was 305 MB of a tree the bundles already contained,
// Sentry 11's build tooling included. The rest of dist stays as swc wrote it, and
// nothing runs it.
//
// swc already emitted the decorator metadata Nest's injection reads
// (`design:paramtypes`), so bundling its output keeps that intact. esbuild cannot
// emit the metadata itself, which is why this bundles swc's JavaScript rather
// than the TypeScript.
//
// Sentry instruments a library by hooking `require`, and a bundled library is
// never required, so its module-level auto-instrumentation no longer applies.
// That costs nothing in use: tracing is off (tracesSampleRate 0, D28), and error
// capture, the uncaught-exception and unhandled-rejection handlers, and node's
// built-ins (`http` among them, which stay `require`d) are unaffected.
import { build } from "esbuild";

// Packages left out of the bundle, and so `require`d at run time if ever reached
// — from an image that has no node_modules (D182), so one the api needs is a
// MODULE_NOT_FOUND.
//
// Every one is an optional peer behind a try/catch or a require-by-name (which a
// bundle would turn into a build failure), or native. None is on the boot path,
// and the integration suite runs the bundles with nothing to fall back on, so one
// that is fails there rather than in production.
const EXTERNAL = [
  // The mongodb driver's optional peers: compression, Kerberos, AWS and GCP
  // credential providers, client-side encryption. Not `socks`, which the driver
  // also loads lazily: the tunnel dialer (engine/socks-dial.ts) imports it, so it
  // is a dependency here, and bundled it serves the driver's require as well —
  // external, it would be the one package the images had to install.
  "kerberos",
  "@mongodb-js/zstd",
  "snappy",
  "gcp-metadata",
  "aws4",
  "mongodb-client-encryption",
  "@aws-sdk/credential-providers",
  // Native bindings: pg's optional libpq one, ssh2's CPU feature probe, and the
  // optional accelerators of the WebSocket library.
  "pg-native",
  "cpu-features",
  "bufferutil",
  "utf-8-validate",
  // Nest's integrations, required by name only by an application that uses
  // them. This one uses none.
  "@nestjs/microservices",
  "@nestjs/microservices/microservices-module",
  "@nestjs/websockets",
  "@nestjs/websockets/socket-module",
  "@nestjs/platform-express",
  "class-validator",
  "class-transformer",
  "@fastify/view",
  "@fastify/static",
  // Loaded by Nest 12's Fastify adapter only for multipart bodies, which no
  // route here accepts.
  "@fastify/multipart",
  // cosmiconfig, which graphile-worker uses to look for a config file, requires
  // TypeScript to read a `.ts` one. This app has none, and TypeScript is a
  // devDependency that the runtime image does not install. Bundled, it was 9.5 of
  // the bundle's 26 MB, all of it parsed at every boot.
  "typescript",
];

// Every file the images run. The Dockerfiles copy exactly these and nothing else
// from dist, so an entrypoint added here and not there is not in the image —
// and one added there and not here is swc's per-file output, which requires
// what the image does not install.
const ENTRYPOINTS = ["main", "migrate", "rotate-key", "set-plan"];

for (const entry of ENTRYPOINTS) {
  await build({
    entryPoints: [`dist/${entry}.js`],
    outfile: `dist/${entry}.js`,
    allowOverwrite: true,
    bundle: true,
    platform: "node",
    target: "node26",
    format: "cjs",
    external: EXTERNAL,
    // Warnings and errors only, so a successful build stays quiet in CI.
    logLevel: "warning",
  });
}
