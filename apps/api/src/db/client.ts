import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { captureError } from "../errors/reporting";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

// `max` is required rather than defaulted, because pg's own default of 10 was
// what every call site here was accepting by omission — and there are three
// long-lived pools in one api process (this one through DatabaseService, the
// jobs' shared pool, and better-auth's), so the process was quietly entitled to
// thirty postgres backends. Each backend costs memory on the DATABASE server,
// and a self-hosted postgres ships max_connections=100.
//
// Naming it per call site keeps that visible: a short-lived migration wants two,
// a request pool wants what its concurrency needs. Too low shows up as latency
// rather than errors — pg queues a request until a connection frees — so the
// symptom of getting this wrong is slow, not broken.
export function createDatabase(connectionString: string, max: number) {
  const pool = new Pool({ connectionString, max });
  // A pg Pool is an EventEmitter that emits 'error' when an IDLE client's
  // connection dies — a backend restart, a network drop — and an EventEmitter
  // 'error' with no listener is an uncaught exception, so every pool built here
  // was one idle-client hiccup away from taking its process down. Nothing ever
  // noticed because nothing checked: graphile-worker 0.17 does (it warns when
  // the pgPool it is handed has zero 'error' listeners), and the kind test's
  // clean-logs rule is what surfaced that warning once #231 started handing it
  // this pool. pg already terminates and evicts the dead client itself, so the
  // handler's job is to exist and to say what happened — loudly, not silently.
  pool.on("error", (error) => {
    console.error(`postgres pool: idle client errored: ${String(error)}`);
    captureError(error, { task: "pg-pool" });
  });
  // The other half of the same crash: a client CHECKED OUT of the pool emits
  // connection errors on itself, not on the pool. pg re-raises the failure from
  // the client's next query — which the normal error paths already log and
  // capture — so this listener only has to keep the emitter from throwing, and
  // a log line is enough; capturing here too would report every such fault
  // twice. graphile-worker checks for a 'connect' listener alongside 'error',
  // and this is also what it wires there itself.
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      console.error(`postgres pool: active client errored: ${String(error)}`);
    });
  });
  return drizzle(pool, { schema });
}

// Drain the underlying pg pool (graceful shutdown).
export async function closeDatabase(db: Database): Promise<void> {
  await db.$client.end();
}
