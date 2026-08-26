import { Controller, Logger, Req } from "@nestjs/common";
import { ORPCError } from "@orpc/server";
import { contract } from "@repo/contracts";
import type { FastifyRequest } from "fastify";
import { AuditService } from "../audit/audit.service";
import type { SecurityEventDetails } from "../audit/audit.types";
import { RequestActorService } from "../audit/request-actor.service";
import { clusters } from "../db";
import { DatabaseService } from "../db/database.service";
import { type DialProxy, NO_TLS_OVERRIDES, type ProvisionedUser } from "../engine/ports";
import { ProvisionDeniedError } from "../engine/provision";
import { adapterFor, detectEngine, supportedEngineOptions } from "../engine/registry";
import { mapClusterError, toCluster, toDiagnosis } from "../http/mappers";
import { TenancyService } from "../http/tenancy.service";
import { ClusterGoneError, unsealCluster } from "../jobs/cluster-connection";
import { evictCluster } from "../jobs/connection-pool";
import { Implement, route } from "../orpc/implement";
import { TunnelService } from "../tunnel/tunnel.service";
import { ClustersRepository } from "./clusters.repository";
import { ClustersService } from "./clusters.service";
import { assertLeastPrivilege } from "./least-privilege";

// Connecting, diagnosing, rotating and disconnecting customer clusters — the
// endpoints that dial a host the user named. Owner-only throughout.
@Controller()
export class ClustersController {
  private readonly log = new Logger(ClustersController.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly tenancy: TenancyService,
    private readonly clusters: ClustersService,
    private readonly audit: AuditService,
    private readonly actors: RequestActorService,
    private readonly tunnels: TunnelService,
    private readonly repository: ClustersRepository,
  ) {}

  // Refuse a name the org is already using, BEFORE anything is dialed.
  //
  // The constraint is what actually enforces it, and it is caught at the insert
  // too — but only as the backstop for two connects racing. Asking first is what
  // keeps a collision from being discovered after `provisionCluster` has created
  // a user on somebody's cluster, which nothing would then clean up.
  // `exceptClusterId` is the cluster being renamed: a rename that keeps the name
  // is a no-op, not a collision with itself.
  private assertNameFree(
    orgId: string,
    name: string,
    errors: { BAD_REQUEST: (options: { message: string }) => Error },
  ): Promise<void> {
    return this.clusters.assertNameFree(orgId, name, errors);
  }

  // One row in the security trail for something done to a cluster's access
  // (#53). Connecting, disconnecting, rotating credentials and flipping the mode
  // are all owner-level acts on somebody's production database, and until now
  // only the index pipeline left any record — `actions` covers what the engine
  // did and nothing about who let it.
  //
  // After the act, never in front of it, and it cannot fail the request:
  // recordSecurityEvent logs a lost row instead of throwing (see its comment).
  private async record(req: FastifyRequest, entry: SecurityEventDetails): Promise<void> {
    const actor = await this.actors.actorFromRequest(req);
    await this.audit.record({ ...entry, ...actor }, (message) => this.log.warn(message));
  }

  // Onboarding preflight: what can these credentials actually do? Nothing is
  // stored and nothing is written on the customer cluster — the dashboard uses
  // this to name missing privileges, or to offer creating a scoped user when
  // the credentials are privileged enough.
  @Implement(contract.listClusters)
  listClusters(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listClusters, req, "session").handler(
      async ({ context }) => {
        // Empty rather than an error for a caller who is in no organization yet:
        // this is one of the three reads the dashboard shell makes before it knows
        // what to draw, and a 403 there would render "the api is unreachable" to
        // someone whose api is fine and who simply has no org. `session`, not
        // `member`, for exactly that reason.
        const orgId = context.member?.orgId ?? null;
        if (orgId === null) return [];
        return this.clusters.list(orgId);
      },
    );
  }

  // What this build can connect (#239). No tenant data and no org in the answer,
  // so it is the loosest level any of these routes runs at — a signed-in reader
  // asking what the product supports. Deliberately not public: it names the
  // engines an installation carries, and the connect page is behind sign-in
  // anyway, so there is nothing to gain by answering strangers.
  @Implement(contract.listSupportedEngines)
  listSupportedEngines(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listSupportedEngines, req, "session").handler(() =>
      supportedEngineOptions(),
    );
  }

  @Implement(contract.checkConnection)
  checkConnection(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.checkConnection, req, "owner").handler(
      async ({ input, errors, context }) => {
        await this.tenancy.requireOwner(req);
        // An explicit engine wins; otherwise the string itself says (mongodb:// vs
        // mssql:// vs ADO Server=… are disjoint), so the web form needs no
        // engine picker to connect a SQL Server. MONGODB last, for strings
        // nothing claims — its adapter then refuses with the right hint.
        const engine = input.engine ?? detectEngine(input.connectionString) ?? "MONGODB";
        const adapter = adapterFor(engine);
        // The checkboxes are applied to the string BEFORE anything looks at it, so
        // the preflight answers for the connection that would actually be stored
        // rather than for the one that was typed.
        const overrides = input.tlsOverrides ?? NO_TLS_OVERRIDES;
        const value = adapter.applySecureTransport(input.connectionString, overrides);
        // Resolved BEFORE the guard, because the guard's rules depend on it: a
        // tunnelled cluster is judged against the tunnel's AllowedIPs instead
        // of against our own network.
        const routed = await this.resolveTunnel(
          input.tunnelId ?? null,
          context.member.orgId,
          errors,
        );
        await this.clusters.guardDial(
          context.userId,
          engine,
          value,
          errors,
          overrides,
          routed.allowedIps,
        );
        // The scope reaches the adapter, so a second check with fewer databases
        // ticked can turn a privilege gap into a grant (#244) — see the field's
        // comment in inputs.ts. Absent on the first check, which has no list yet.
        return toDiagnosis(
          engine,
          await adapter.diagnose(value, overrides, input.observedDatabases, routed.proxy),
        );
      },
    );
  }

  @Implement(contract.createCluster)
  createCluster(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.createCluster, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        // Before the dial, not after: refusing on the plan should not first spend
        // several seconds connecting to a cluster we are not going to keep. Same
        // for the name.
        await this.tenancy.requireRoomFor(orgId, "clusters");
        await this.assertNameFree(orgId, input.name, errors);
        // An explicit engine wins; otherwise the string itself says (mongodb:// vs
        // mssql:// vs ADO Server=… are disjoint), so the web form needs no
        // engine picker to connect a SQL Server. MONGODB last, for strings
        // nothing claims — its adapter then refuses with the right hint.
        const engine = input.engine ?? detectEngine(input.connectionString) ?? "MONGODB";
        const adapter = adapterFor(engine);
        const overrides = input.tlsOverrides ?? NO_TLS_OVERRIDES;
        const value = adapter.applySecureTransport(input.connectionString, overrides);
        const routed = await this.resolveTunnel(input.tunnelId ?? null, orgId, errors);
        await this.clusters.guardDial(
          context.userId,
          engine,
          value,
          errors,
          overrides,
          routed.allowedIps,
        );
        // Verify before storing: an unusable string must fail at connect time
        // with the reason, not silently collect nothing for a day.
        const diagnosis = await adapter.diagnose(
          value,
          overrides,
          input.observedDatabases,
          routed.proxy,
        );
        // A selection naming a database this cluster does not have is refused here
        // rather than stored and quietly intersected away by every collect: the
        // reader picked from a list we gave them, so a name that is not on it means
        // the cluster changed under them or the caller is scripted and wrong. Both
        // are worth a sentence at connect time.
        const absent = (input.observedDatabases ?? []).filter(
          (name) => !diagnosis.databases.includes(name),
        );
        if (diagnosis.reachable && absent.length > 0) {
          throw errors.BAD_REQUEST({
            message:
              `this cluster has no database called ${absent.join(", ")} — ` +
              `it reports ${diagnosis.databases.join(", ") || "none"}.`,
          });
        }
        if (!diagnosis.reachable) {
          throw new ORPCError("CLUSTER_UNREACHABLE", {
            status: 502,
            message: diagnosis.message ?? "cluster unreachable",
          });
        }
        if (!diagnosis.ready) {
          throw errors.BAD_REQUEST({
            message:
              `these credentials are missing: ${diagnosis.missing.join(", ")}. ` +
              "Grant them, or connect with credentials that can create users and let " +
              "Indexterity provision a scoped one.",
          });
        }
        // After the dial and before the seal (#313). It has to be after, because
        // whether a string can create users is a question only the cluster can
        // answer — the policy is enforced against the diagnosis, never against
        // the shape of what was typed. `provisionCluster` next door is
        // deliberately NOT gated: it is the path this refusal sends people to,
        // and the admin string it takes is never stored.
        await assertLeastPrivilege(this.database.db, orgId, diagnosis);
        const row = await this.clusters.storeCluster(
          orgId,
          input.name,
          engine,
          value,
          null,
          // Read off the diagnosis rather than the string: whether credentials
          // can create users is a question only the server can answer.
          diagnosis.canProvision ? "ADMIN" : "SCOPED",
          overrides,
          input.observedDatabases ?? null,
          input.tunnelId ?? null,
        );
        await this.record(req, {
          event: "CLUSTER_CONNECTED",
          orgId,
          clusterId: row.id,
          target: row.name,
          // Which concessions were made and whether we are holding somebody's own
          // credentials — the two facts an incident asks about a connection.
          metadata: {
            engine,
            provisioned: false,
            tlsOverrides: overrides,
            observedDatabases: input.observedDatabases ?? null,
          },
        });
        return toCluster(row);
      },
    );
  }

  // Admin-string onboarding: the admin credentials are used once to create a
  // least-privilege user + role on the customer cluster, then discarded — only
  // the scoped user's string is sealed and stored.
  @Implement(contract.provisionCluster)
  provisionCluster(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.provisionCluster, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        // Before creating a user on someone's cluster, not after.
        await this.tenancy.requireRoomFor(orgId, "clusters");
        await this.assertNameFree(orgId, input.name, errors);
        // The string says which engine this is, exactly as createCluster reads
        // it — so an admin SQL Server string provisions a scoped login instead
        // of being dialled as mongo. An engine whose adapter cannot provision
        // is refused here rather than part way through. An explicit engine wins
        // for the same reason it does on the other two: the reader who overrode
        // detection to get a diagnosis presses this button next, and re-deciding
        // here would provision against a different engine than they were shown.
        const engine = input.engine ?? detectEngine(input.adminConnectionString) ?? "MONGODB";
        const adapter = adapterFor(engine);
        const provision = adapter.provisionScopedUser;
        if (!adapter.capabilities.provisionScopedUsers || provision === undefined) {
          throw errors.BAD_REQUEST({
            message:
              `${engine} cannot provision a scoped user — connect with credentials that ` +
              "already have what the engine needs instead.",
          });
        }
        const overrides = input.tlsOverrides ?? NO_TLS_OVERRIDES;
        const adminValue = adapter.applySecureTransport(input.adminConnectionString, overrides);
        // Provisioning dials the customer's cluster with an ADMIN string, so it
        // has to go the same way a collect will — a database behind a VPN is
        // not reachable for this either.
        const routed = await this.resolveTunnel(input.tunnelId ?? null, orgId, errors);
        await this.clusters.guardDial(
          context.userId,
          engine,
          adminValue,
          errors,
          overrides,
          routed.allowedIps,
        );
        let provisioned: ProvisionedUser;
        try {
          // No selection passed, on purpose: what the provisioned user may reach is
          // not what we choose to observe (#244, and the port's own comment). The
          // selection is stored on the row below and applies to every collect;
          // narrowing the GRANTS would make it un-editable, because there is no
          // admin string left afterwards to widen them with.
          provisioned = await provision(adminValue, overrides, routed.proxy);
        } catch (error) {
          if (error instanceof ProvisionDeniedError) {
            throw new ORPCError("PROVISION_DENIED", { status: 422, message: error.message });
          }
          mapClusterError(error);
        }
        const row = await this.clusters.storeCluster(
          orgId,
          input.name,
          engine,
          provisioned.connectionString,
          { username: provisioned.username, databases: provisioned.databases },
          // Known exactly here, unlike either other case: Indexterity created
          // this user, so its ceiling is the scoped role and nothing more.
          "PROVISIONED",
          overrides,
          input.observedDatabases ?? null,
          input.tunnelId ?? null,
        );
        await this.record(req, {
          event: "CLUSTER_CONNECTED",
          orgId,
          clusterId: row.id,
          target: row.name,
          // The username, never the string: this row is read by people who are not
          // meant to be able to dial the cluster from it.
          metadata: {
            engine,
            provisioned: true,
            provisionedUsername: provisioned.username,
            tlsOverrides: overrides,
            observedDatabases: input.observedDatabases ?? null,
          },
        });
        return {
          cluster: toCluster(row),
          username: provisioned.username,
          connectionString: provisioned.connectionString,
        };
      },
    );
  }

  // Owner-only credential rotation: the new string is dialed and pinged BEFORE
  // it replaces the stored one (a typo must not brick the cluster), then the
  // pooled connection is evicted so the old credentials stop being used
  // immediately. History (snapshots, ROI, audit) survives — this is the
  // alternative to disconnect + reconnect.
  @Implement(contract.rotateConnection)
  rotateConnection(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.rotateConnection, req, "freshOwner").handler(
      async ({ input, errors, context }) => {
        // `freshOwner`, not merely owner: this replaces the credentials the
        // engine dials the customer's cluster with (#52).
        const orgId = context.member.orgId;
        const row = await this.clusters.ownedById(input.clusterId, orgId, errors);
        const adapter = adapterFor(row.engine);
        // Unstated on a rotation means "as before": rotating a password should not
        // silently withdraw a concession the cluster still needs to connect at all.
        const overrides = input.tlsOverrides ?? row.tlsOverrides;
        const value = adapter.applySecureTransport(input.connectionString, overrides);
        await this.clusters.guardDial(context.userId, row.engine, value, errors, overrides);
        try {
          const probe = await adapter.open(value, overrides);
          try {
            await probe.ping();
          } finally {
            await probe.close();
          }
        } catch (error) {
          mapClusterError(error);
        }
        // The scoped-user marker only survives if the new string still
        // authenticates as that user; anything else is a user we didn't create.
        const provisionedUsername =
          row.provisionedUsername !== null &&
          adapter.connStringUsername(input.connectionString) === row.provisionedUsername
            ? row.provisionedUsername
            : null;
        // Re-evaluated here because rotating is exactly when it changes: swapping
        // an admin string for a scoped one is a narrowing somebody should be able
        // to see happened, and the reverse is a widening they should see too.
        //
        // A diagnosis that fails leaves it NULL rather than failing the rotation
        // or keeping the old value. The rotation itself already succeeded — the
        // string pinged — and recording "we no longer know" is honest where
        // carrying forward a posture measured on different credentials is not.
        //
        // Kept as the diagnosis rather than collapsed straight to the enum,
        // because the policy gate below reads two of its fields (#313) and asking
        // the cluster twice for the same answer would double a rotation's cost.
        const diagnosis =
          provisionedUsername !== null
            ? null
            : await adapter.diagnose(value, overrides).catch(() => null);
        const credentialPosture =
          provisionedUsername !== null
            ? "PROVISIONED"
            : diagnosis === null
              ? null
              : diagnosis.canProvision
                ? ("ADMIN" as const)
                : ("SCOPED" as const);
        // The other door (#313). A cluster already connected is rotated rather
        // than re-connected, so a policy checked only at createCluster would be
        // one PATCH away from being bypassed — and rotating is precisely when
        // breadth changes, which is why the posture column exists at all.
        //
        // A diagnosis that could not be taken is NOT refused. The string pinged,
        // so the credentials work; what failed is our ability to describe them,
        // and refusing on that would mean a cluster whose diagnosis is flaky
        // cannot have its password changed — the one operation an incident needs
        // most. The unknown posture is recorded as null instead, and the
        // connection card draws "posture not recorded", which is the state that
        // asks a human to look.
        if (diagnosis !== null) {
          await assertLeastPrivilege(this.database.db, orgId, diagnosis);
        }
        const updated = await this.clusters.reseal(
          input.clusterId,
          input.connectionString,
          {
            provisionedUsername,
            // Travels with the marker above, both ways. Rotating onto a string
            // that is not the scoped user drops the username, and the databases
            // it was created in stop describing anything this row still holds —
            // keeping them would make the disconnect screen offer to remove a
            // user this cluster no longer runs as (#338).
            provisionedDatabases: provisionedUsername === null ? null : row.provisionedDatabases,
            credentialPosture,
          },
          errors,
        );
        await evictCluster(input.clusterId);
        await this.record(req, {
          event: "CLUSTER_CREDENTIALS_ROTATED",
          orgId,
          clusterId: updated.id,
          target: updated.name,
          // Whether the cluster is still running as a user we created, which is what
          // decides who can revoke that access afterwards.
          metadata: {
            provisionedUsername,
            keptScopedUser: provisionedUsername !== null,
            tlsOverrides: overrides,
          },
        });
        return toCluster(updated);
      },
    );
  }

  // Owner-only offboarding: leave the customer's cluster as we found it
  // (un-hide anything still parked in the observe window — restoration runs
  // even on read-only clusters), drop the pooled connection, delete the row
  // (cascade wipes snapshots, recommendations, actions, ROI, policy, cooldowns,
  // latency samples), and hand back the command to revoke the provisioned user.
  @Implement(contract.deleteCluster)
  deleteCluster(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.deleteCluster, req, "freshOwner").handler(
      async ({ input, errors, context }) => {
        // `freshOwner`, not merely owner: everything collected is deleted and
        // cannot be re-collected as it was (#52).
        return this.clusters.disconnect(
          context.member.orgId,
          input.clusterId,
          errors,
          () => this.actors.actorFromRequest(req),
          (message) => this.log.warn(message),
        );
      },
    );
  }

  // Owner-only rename. A plain update of one column, and the only way there has
  // ever been to correct a name: before this, the sole route to a different one
  // was disconnect and reconnect, which deletes every snapshot, recommendation,
  // ROI figure and audit row the cluster had. A cluster observed for three months
  // could not be renamed at any acceptable price (#96).
  //
  // Nothing on the customer's cluster is affected — the provisioned user is
  // derived from the admin connection string, never from this name.
  @Implement(contract.renameCluster)
  renameCluster(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.renameCluster, req, "owner").handler(
      async ({ input, errors, context }) => {
        return this.clusters.rename(context.member.orgId, input.clusterId, input.name, errors);
      },
    );
  }

  // Owner-only: flip a cluster between read-only and live mode.
  @Implement(contract.setClusterMode)
  setClusterMode(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.setClusterMode, req, "owner").handler(
      async ({ input, errors, context }) => {
        // `owner` is the floor and the escalation stays here, because which of
        // the two applies is a fact about the INPUT rather than about the route:
        // going live is the moment the engine gains permission to write, so it
        // takes a fresh sign-in, and the way BACK to read-only deliberately does
        // not — an emergency stop that waits on a password re-prompt is not an
        // emergency stop (#52).
        if (!input.readOnly) await this.tenancy.requireFreshOwner(req);
        return this.clusters.setMode(
          context.member.orgId,
          input.clusterId,
          input.readOnly,
          errors,
          () => this.actors.actorFromRequest(req),
          (message) => this.log.warn(message),
        );
      },
    );
  }

  // The databases this cluster HAS, for the screen that picks which of them to
  // observe (#244).
  //
  // Dials the cluster on a GET, which is unusual here and is the point: the whole
  // reason this route exists is to offer a database that appeared after
  // onboarding, and nothing we have collected can know about one we have never
  // looked at. The lease is `allDatabases`, so the answer is what the cluster has
  // rather than what we are already watching.
  //
  // No dial budget is spent, unlike the onboarding routes. That budget exists to
  // stop one account sweeping arbitrary hosts (errors/dial-budget.ts); this dials
  // a string the org already connected and the guard already vetted, and charging
  // it would let a settings page a reader opens twice exhaust the allowance that
  // protects the connect form.
  @Implement(contract.listClusterDatabases)
  listClusterDatabases(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.listClusterDatabases, req, "owner").handler(
      async ({ input, errors, context }) => {
        await this.tenancy.assertOwnsCluster(input.clusterId, context.member.orgId, errors);
        return this.clusters.listDatabases(input.clusterId, errors);
      },
    );
  }

  // Re-check the STORED credentials against the cluster (#313).
  //
  // Everything on the connection card until now was recorded at connect time and
  // never asked again: `credentialPosture` is one enum stamped when the string was
  // sealed, so a card drawn from it says what was true on the day somebody pasted
  // it and cannot say what is true now. This dials.
  //
  // Same dial guard as every other endpoint that opens a customer connection, and
  // the same per-user budget: the stored string is not exempt from the SSRF checks
  // just because it was accepted once — the host it names could have been
  // re-pointed since, and the budget is what stops this route from being a way to
  // sweep hosts one refresh at a time.
  //
  // A cluster that cannot be dialled answers 200 with `reachable: false` rather
  // than a 502, unlike a rotation. The card is where an unreachable cluster's
  // credentials get fixed, and a panel that refuses to render on the one screen
  // that can fix it is the failure #289 is about — the message says what happened
  // and the rotate form underneath still works.
  @Implement(contract.getClusterPrivileges)
  getClusterPrivileges(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.getClusterPrivileges, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        await this.tenancy.assertOwnsCluster(input.clusterId, orgId, errors);
        let cluster: typeof clusters.$inferSelect;
        let connectionString: string;
        try {
          const unsealed = await unsealCluster(this.database.db, input.clusterId);
          cluster = unsealed.cluster;
          connectionString = unsealed.connectionString;
        } catch (error) {
          if (error instanceof ClusterGoneError) {
            throw errors.NOT_FOUND({ message: "cluster not found" });
          }
          throw error;
        }
        const adapter = adapterFor(cluster.engine);
        await this.clusters.guardDial(
          context.userId,
          cluster.engine,
          connectionString,
          errors,
          cluster.tlsOverrides,
        );
        // Stamped before the dial rather than after, so a slow probe cannot label
        // its own answer as newer than it is.
        const checkedAt = new Date().toISOString();
        let diagnosis: Awaited<ReturnType<typeof adapter.diagnose>>;
        try {
          // Asked about the databases this cluster actually observes (#244), not
          // about the whole server: a role scoped to the one database somebody
          // ticked is not missing anything, and a surplus write grant on a
          // database nobody observes is not what this card is about.
          diagnosis = await adapter.diagnose(
            connectionString,
            cluster.tlsOverrides,
            cluster.observedDatabases,
          );
        } catch (error) {
          // The adapters return `reachable: false` for the failures they
          // recognise; this is the rest. Reported in the same shape rather than
          // as a 500, for the reason in the comment above the route.
          return {
            clusterId: input.clusterId,
            engine: cluster.engine,
            checkedAt,
            reachable: false,
            message: error instanceof Error ? error.message : String(error),
            username: null,
            authEnabled: false,
            required: [],
            surplus: [],
          };
        }
        return {
          clusterId: input.clusterId,
          engine: cluster.engine,
          checkedAt,
          reachable: diagnosis.reachable,
          message: diagnosis.message,
          username: diagnosis.username,
          authEnabled: diagnosis.authEnabled,
          // PROVISION checks are dropped here and only here. On the connect form
          // they answer "could we make a scoped user out of this"; on a cluster
          // that already exists that offer is gone — provisioning runs from an
          // admin string that was never stored — so the three rows would be a
          // question nobody can act on, sitting in a group headed "what the engine
          // needs". Whether the string is over-broad is the posture badge's job
          // and the surplus list's, both of which are on the same card.
          required: diagnosis.privileges.filter((check) => check.tier !== "PROVISION"),
          surplus: [...diagnosis.surplus],
        };
      },
    );
  }

  // Replace which databases the collect walks.
  //
  // `owner` rather than `freshOwner`, which is the line rotation, going live and
  // disconnecting are all on the other side of. Those three change what the
  // control plane HOLDS or lets the engine WRITE; this changes how much of a
  // cluster the org already connected we read, with credentials that could already
  // read all of it. Recorded in the security trail either way, because widening it
  // is how we start reading a database we were not reading yesterday.
  @Implement(contract.setObservedDatabases)
  setObservedDatabases(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.setObservedDatabases, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        const row = await this.clusters.ownedById(input.clusterId, orgId, errors);
        // Checked against the cluster rather than against what we have collected,
        // for the same reason the GET above dials: a name that is only wrong
        // because we have never observed it is exactly the name this route exists
        // to accept.
        if (input.databases !== null) {
          // Only what is being ADDED is probed for access, so narrowing a cluster
          // never waits on a per-database round trip.
          const added = input.databases.filter(
            (name) => row.observedDatabases !== null && !row.observedDatabases.includes(name),
          );
          const { absent, unreadable } = await this.clusters.unusableDatabases(
            input.clusterId,
            input.databases,
            added,
            errors,
          );
          if (absent.length > 0) {
            throw errors.BAD_REQUEST({
              message:
                `this cluster has no database called ${absent.join(", ")} — ` +
                "reload the list and pick again.",
            });
          }
          // Refused at the tick rather than accepted into a blind spot. The credentials
          // stored for this cluster cannot read these databases at all, so observing
          // them would collect nothing from them forever and say so nowhere.
          //
          // Provisioning is not narrowed to the selection (#244), so this is no longer
          // about the boxes somebody ticked at connect time — it is the residual gap
          // that decision leaves: provisioning grants per database and runs once, so a
          // database CREATED afterwards has no user for the login and no admin string
          // survives to give it one. Hence the message names both ways out.
          if (unreadable.length > 0) {
            throw errors.BAD_REQUEST({
              message:
                `these credentials cannot read ${unreadable.join(", ")} on this cluster` +
                (row.provisionedUsername === null
                  ? ". Grant them access and try again."
                  : ` — ${row.provisionedUsername} was granted in the databases that existed when ` +
                    "it was created, and the admin string it was made with is never stored, so a " +
                    "database created since then has no user for it. Grant it there yourself, or " +
                    "rotate to a connection string that already has access."),
            });
          }
        }
        // Proposals for a database that just left the selection, discarded before
        // the column is written: an approval that fires between the two would act
        // on a database the owner has already said to leave alone.
        //
        // Only the states where nothing has happened on the customer's cluster
        // yet. HIDDEN, OBSERVE and BUILDING are excluded deliberately — the engine
        // has already changed something there, the row is the only record of it,
        // and offboard.ts reads exactly those states to put it back. Dropping them
        // would leave an index hidden on a database nobody is watching, with
        // nothing left that knows to unhide it.
        const discarded = await this.clusters.discardProposalsOutsideScope(
          input.clusterId,
          input.databases,
        );
        const updated = await this.clusters.setObservedDatabases(
          orgId,
          input.clusterId,
          input.databases,
          errors,
        );
        await this.record(req, {
          event: "CLUSTER_OBSERVED_DATABASES_CHANGED",
          orgId,
          clusterId: updated.id,
          target: updated.name,
          metadata: {
            from: row.observedDatabases,
            to: input.databases,
            discardedRecommendations: discarded,
          },
        });
        return toCluster(updated);
      },
    );
  }

  // Which of these names the cluster does not have. Empty when it has them all,
  // and empty when the cluster cannot be reached to say — a selection must not be
  // refused because the cluster was briefly down, and the filter in
  // jobs/cluster-connection.ts intersects on every collect regardless, so a name
  // that turns out to be wrong costs nothing but its own absence.
  @Implement(contract.triggerCollect)
  triggerCollect(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.triggerCollect, req, "owner").handler(
      async ({ input, errors, context }) => {
        await this.tenancy.assertOwnsCluster(input.clusterId, context.member.orgId, errors);
        return this.clusters.queueCollect(input.clusterId);
      },
    );
  }

  /**
   * The tunnel this connect is routed through, brought up so the preflight
   * dials the same way a collect will.
   *
   * Returns both halves because they are used at different moments and by
   * different rules: `allowedIps` decides what the network guard will permit
   * before anything is dialled, and `proxy` is how the driver actually reaches
   * it. Null for the ordinary case of a cluster we can already open a socket
   * to, which is most of them.
   */
  // Which tunnel reaches this cluster, or null to dial it directly (#353).
  //
  // Here rather than in TunnelController, and not only because the path says
  // /clusters: putting it there made ClustersModule and TunnelModule import
  // each other, and a forwardRef would have hidden a cycle rather than removed
  // one. A tunnel assignment is a property of the CLUSTER.
  @Implement(contract.setClusterTunnel)
  setClusterTunnel(@Req() req: FastifyRequest) {
    return route(this.tenancy, contract.setClusterTunnel, req, "owner").handler(
      async ({ input, errors, context }) => {
        const orgId = context.member.orgId;
        await this.tenancy.assertOwnsCluster(input.clusterId, orgId, errors);
        // Checked rather than trusted: a tunnel id from another org would
        // otherwise route this org's dials through somebody else's network.
        if (input.tunnelId !== null && !(await this.tunnels.ownedBy(input.tunnelId, orgId))) {
          throw errors.BAD_REQUEST({ message: "no such tunnel" });
        }
        const row = await this.repository.setTunnel(input.clusterId, orgId, input.tunnelId);
        if (row === undefined) throw errors.NOT_FOUND({ message: "no such cluster" });
        return toCluster(row);
      },
    );
  }

  private async resolveTunnel(
    tunnelId: string | null,
    orgId: string,
    errors: { BAD_REQUEST: (options: { message: string }) => Error },
  ): Promise<{ allowedIps: readonly string[] | null; proxy: DialProxy | undefined }> {
    if (tunnelId === null) return { allowedIps: null, proxy: undefined };
    // Checked rather than trusted: a tunnel id from another org would otherwise
    // route this org's dial through somebody else's network.
    if (!(await this.tunnels.ownedBy(tunnelId, orgId))) {
      throw errors.BAD_REQUEST({ message: "no such tunnel" });
    }
    try {
      const opened = await this.tunnels.openFor(tunnelId);
      return { allowedIps: opened.allowedIps, proxy: opened.proxy };
    } catch (error) {
      // A tunnel that will not come up is a reason a connect fails, and saying
      // which one beats "unreachable" — the owner would otherwise go looking at
      // the database.
      throw errors.BAD_REQUEST({
        message: `the tunnel could not be brought up: ${(error as Error).message}`,
      });
    }
  }
}
