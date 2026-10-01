// Bundle the api's entrypoint into one file, after swc has compiled it (#567).
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
// The bundle REPLACES dist/main.js, so everything that boots the api boots it:
// the integration suite spawns dist/main.js, and so do the images, e2e, and the
// chart's kind installs. The rest of dist stays as swc wrote it, because the
// other entrypoints (migrate.js, rotate-key.js, set-plan.js) run per file and
// are not worth bundling: they start once and exit.
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

// Packages left out of the bundle, and so `require`d at run time if ever reached.
//
// Every one is either not installed (an optional peer behind a try/catch or a
// require-by-name, which a bundle would turn into a build failure) or native.
// None is on the boot path.
const EXTERNAL = [
  // The mongodb driver's optional peers: compression, Kerberos, SOCKS, AWS and
  // GCP credential providers, client-side encryption.
  "kerberos",
  "@mongodb-js/zstd",
  "snappy",
  "socks",
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
  // cosmiconfig, which graphile-worker uses to look for a config file, requires
  // TypeScript to read a `.ts` one. This app has none, and TypeScript is a
  // devDependency that the runtime image does not install. Bundled, it was 9.5 of
  // the bundle's 26 MB, all of it parsed at every boot.
  "typescript",
];

await build({
  entryPoints: ["dist/main.js"],
  outfile: "dist/main.js",
  allowOverwrite: true,
  bundle: true,
  platform: "node",
  target: "node26",
  format: "cjs",
  external: EXTERNAL,
  // Warnings and errors only, so a successful build stays quiet in CI.
  logLevel: "warning",
});
