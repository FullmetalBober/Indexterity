import { Body, Controller, Headers, Post, UnauthorizedException } from "@nestjs/common";
import { snapshotInput } from "@repo/contracts";
import { clusters, eq, indexSnapshots } from "@repo/db";
import { DatabaseService } from "../db/database.service";
import { classifyCluster } from "../jobs/classify";

function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const [scheme, token] = authorization.split(" ");
  return scheme === "Bearer" && token !== undefined && token !== "" ? token : null;
}

// Agent-facing ingest. The agent authenticates with its per-cluster token; the
// control plane never holds the customer's Mongo credentials in agent mode.
@Controller("agent")
export class AgentController {
  constructor(private readonly database: DatabaseService) {}

  @Post("snapshots")
  async submitSnapshots(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ingested: number }> {
    const token = bearerToken(authorization);
    if (token === null) throw new UnauthorizedException("missing agent token");
    const [cluster] = await this.database.db
      .select()
      .from(clusters)
      .where(eq(clusters.agentToken, token))
      .limit(1);
    if (cluster === undefined) throw new UnauthorizedException("invalid agent token");

    const snapshots = snapshotInput.parse(body);
    if (snapshots.length > 0) {
      await this.database.db
        .insert(indexSnapshots)
        .values(snapshots.map((snapshot) => ({ clusterId: cluster.id, ...snapshot })));
      await classifyCluster(cluster.id);
    }
    return { ingested: snapshots.length };
  }
}
