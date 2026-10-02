import { defineConfig } from "vitest/config";

// Integration suite: spawns the built api (dist/) against real postgres + mongo.
// Run `turbo run build` first; locally: DATABASE_URL/MONGO_URL point at the dev
// containers, in CI at the job services. Sequential — one server, shared state.
export default defineConfig({
  test: {
    include: ["integration/**/*.int.test.ts"],
    environment: "node",
    // Two of the settings `startApi` gives the children it spawns, given to the
    // runner itself, because it is a process too.
    //
    // The suite's own in-process MongoConnection (seeding, assertions) dials the
    // compose mongo, which serves no TLS.
    //
    // And no mail transport, whatever the developer's shell has in it (#584).
    // Some scenarios run the build and finalize jobs in-process, and those mail
    // a cluster's owners: with the repo's .env sourced, the runner sent through
    // the developer's real relay, to @int.test addresses that bounce. Blank
    // reads as unset (config/schema.ts withoutBlanks), so all three are absent,
    // and that is a complete group: mail is off. vitest.integration.setup.ts
    // refuses to run if it is not.
    env: { ALLOW_INSECURE_CLUSTER_TLS: "true", SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "" },
    setupFiles: ["./vitest.integration.setup.ts"],
    // Copies the built api out of the repository before any file runs, so the
    // api this suite spawns resolves nothing from node_modules, as in an image.
    globalSetup: ["./integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
