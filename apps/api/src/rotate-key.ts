import { currentKeyVersion, loadEnvOrExit, masterKeyBytesFor, workerEnv } from "./config/env";
import { clusters, createDatabase, envKeyProvider, eq, ne, open, seal } from "./db";

// Re-seal every stored connection string under the current master key.
//
//   MASTER_KEY_VERSION=2 MASTER_KEY_V2=<new> MASTER_KEY_V1=<old> \
//     node apps/api/dist/rotate-key.js
//
// `MASTER_KEY=<old>` still works — v1 falls back to it — but naming the retired
// key MASTER_KEY_V1 is the spelling that does not read backwards, since with the
// fallback the variable called MASTER_KEY is the one holding the key you are
// getting rid of.
//
// Envelope encryption means only the wrapped DEK changes; the connection string
// is decrypted and re-encrypted in the api process and never leaves it. Rows are
// updated one at a time and each records the version that sealed it, so an
// interrupted run leaves a mix of versions that still opens — as long as BOTH
// keys stay in the environment until the run reports zero remaining.
async function main(): Promise<void> {
  // The worker schema: this rewraps stored credentials, so it needs MASTER_KEY
  // and every MASTER_KEY_V<n> the rotation names.
  loadEnvOrExit("worker");
  const db = createDatabase(workerEnv().DATABASE_URL);
  const target = currentKeyVersion();
  const targetKey = envKeyProvider(masterKeyBytesFor(target));

  const stale = await db.select().from(clusters).where(ne(clusters.keyVersion, target));
  if (stale.length === 0) {
    console.log(`nothing to do — every cluster is already sealed with key version ${target}`);
    await db.$client.end();
    return;
  }
  console.log(`re-sealing ${stale.length} cluster(s) to key version ${target}`);

  let done = 0;
  const failed: string[] = [];
  for (const cluster of stale) {
    try {
      const plaintext = await open(
        { dek: cluster.sealedDek, data: cluster.sealedData },
        envKeyProvider(masterKeyBytesFor(cluster.keyVersion)),
      );
      const resealed = await seal(plaintext, targetKey);
      await db
        .update(clusters)
        .set({
          sealedDek: Buffer.from(resealed.dek),
          sealedData: Buffer.from(resealed.data),
          keyVersion: target,
        })
        .where(eq(clusters.id, cluster.id));
      done += 1;
    } catch (error) {
      // Almost always the old key missing from the environment. Keep going so
      // one unreadable row does not strand the rest.
      failed.push(`${cluster.name} (v${cluster.keyVersion}): ${String(error)}`);
    }
  }

  console.log(`re-sealed ${done}, failed ${failed.length}`);
  for (const line of failed) console.error(`  ${line}`);
  await db.$client.end();
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
