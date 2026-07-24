import { collectSnapshots, MongoConnection } from "@repo/mongo";

// The agent runs inside the customer's network: it holds the local Mongo creds,
// collects snapshots, and pushes them to the control plane over outbound HTTPS.
// The control plane never connects to the customer's Mongo.

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing env ${name}`);
  return value;
}

async function main(): Promise<void> {
  const controlPlaneUrl = requiredEnv("CONTROL_PLANE_URL");
  const agentToken = requiredEnv("AGENT_TOKEN");
  const mongoUrl = requiredEnv("MONGO_URL");

  const conn = new MongoConnection(mongoUrl);
  await conn.connect();
  const snapshots = await collectSnapshots(conn);
  await conn.close();

  const response = await fetch(`${controlPlaneUrl}/agent/snapshots`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
    body: JSON.stringify(snapshots),
  });
  if (!response.ok) {
    throw new Error(`push failed: ${response.status} ${await response.text()}`);
  }
  console.log(`agent: pushed ${snapshots.length} snapshots -> ${response.status}`);
}

void main();
