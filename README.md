# Indexterity

Index dexterity for **MongoDB, PostgreSQL and SQL Server**. It watches your
indexes and manages them safely — drops the unused and redundant, merges
overlapping, extends prefixes, creates the missing — and proves the result in
freed bytes and latency.

**Read-only until you say otherwise.** The one irreversible step, a drop, is
gated behind an observe window, a pre-flight check, a read-latency regression
test, and a check that the workload did not start FAILING while the index was
hidden — which is a separate question, because a query that fails returns faster
than one that works and a latency test reads it as an improvement. Everything
before the drop is reversible, and the dashboard says which is which.

**Some indexes are never dropped automatically, whatever they score.** That gate
is a measurement, and a measurement needs the experiment to be survivable. A
unique index's loss is invisible to it — nothing about latency says duplicates
are now permitted. A text or geo index is worse than invisible: hiding one makes
its own queries **fail** rather than slow down, so there is no experiment to run.
Those, and TTL indexes and shard keys, are reported for a human to act on, with
the reason and the score, rather than being quietly withheld.

**Findings appear before the engine will act on them.** A newly connected cluster
gets usage findings after three days of watching it serve reads, and for the first
week they are yours to approve rather than the engine's to apply on its own.
Waiting a week before deleting an index is caution; waiting a week before
mentioning one is an empty screen.

**It cannot read your data.** Given credentials that can create users, it offers
to provision its own least-privilege one instead — `indexterity`, holding index
metadata and statistics and no read privilege at all. The server enforces that;
it is not a promise we make. The admin string is used once and never stored.

**It shows you what it looked at, not only what it proposes.** Every index a
cluster has, with its size, its flags and which replica-set member is actually
using it — and every query that misses an index, including the ones the engine
decided not to act on and which threshold declined them. An empty
recommendations list should mean "your indexes are fine", and the only way it can
mean that is if you can see the population it is a statement about.

```bash
git clone https://github.com/FullmetalBober/Indexterity.git
cd Indexterity
cp .env.example .env      # every variable is documented in it
npm install
npm run up                # postgres + api + dashboard on localhost:3000
```

Open <http://localhost:3000>, make the first account, connect a cluster. It tells
you what your connection string can actually do before anything is stored.

## Where things are

| | |
|---|---|
| **Run it, develop it, deploy it** | [Running Indexterity](https://github.com/FullmetalBober/Indexterity/wiki/Running-Indexterity) |
| **How it is built, and what it decides** | [Architecture](https://github.com/FullmetalBober/Indexterity/wiki/Architecture) |
| **What holds it shut** | [Security](https://github.com/FullmetalBober/Indexterity/wiki/Security) |
| **Knobs, scoring and plans** | [Plans and policy](https://github.com/FullmetalBober/Indexterity/wiki/Plans-and-policy) |
| **The scoped user it needs** | [Connecting a cluster](https://github.com/FullmetalBober/Indexterity/wiki/Connecting-a-cluster) |
| **Every load-bearing choice** | [`docs/decisions.md`](./docs/decisions.md) |
| **What is planned** | [project board](https://github.com/users/FullmetalBober/projects/6) |

One thing worth knowing before you connect a PostgreSQL cluster: it has no
reversible hide and no grantable index privilege, so the observe window watches
usage while the index keeps serving. Applying therefore takes either credentials
you connect deliberately, or a one-time `pg_cron` setup that lets the
least-privilege role ask for a build which runs as the table owner — so it can
apply without ever being able to read your
data. [Connecting a cluster](https://github.com/FullmetalBober/Indexterity/wiki/Connecting-a-cluster)
has the detail.

A cluster has to be reachable from wherever Indexterity runs, and a database
with no public endpoint is not. **Paste the WireGuard config its network already
uses** and Indexterity terminates the peering itself — in userspace,
needing no privileges and nothing extra running on your side. Register it under
Settings → VPN tunnels, pick it on the connect form, and a VPC-only or on-prem
cluster connects like any other. Registering only reads the file, so each tunnel
has a **Test** that makes your gateway prove it answers, and an **Edit** for the
day a key is rotated or the gateway moves.

The tunnel changes which addresses are reachable and nothing else: TLS is still
required, cloud metadata is still refused whatever route reaches it, and the
connection string is still stored and opened here. Reach is granted **per
peering** — bounded by that config's own `AllowedIPs`, by the org that registered
it — so nothing global has to be relaxed for one tenant to reach one network.

Self-hosted installs run the peering as a sidecar in the api's pod
(`tunnel.enabled` in the chart), which needs no privilege: no `NET_ADMIN`, no
`/dev/net/tun`, a read-only root filesystem. Deployments that would rather route
at the node, or that use a VPN which is not WireGuard, have a
[recipe for their own client](./deploy/helm/indexterity/README.md#reaching-a-database-over-a-vpn)
instead. A deployment with no tunnel service configured reports the feature as
unavailable rather than offering it.

## Licence

[BUSL-1.1](./LICENSE.md) — **source-available, not open source**, and the
difference is worth stating rather than blurring: the Open Source Definition
allows no restriction on commercial use, and this restricts one on purpose. Each
version converts to Apache-2.0 four years after it is published, so nothing here
is withheld permanently.

| | |
|---|---|
| Non-production use | free and unlimited |
| Production, one cluster | free, forever, company or not — every feature |
| Production, more than one | a commercial licence, or the hosted service |
| Reading, modifying, forking, contributing | always permitted |
| Reselling it, or offering it as a service | never permitted |

One cluster means one deployment behind one connection string: a three-node
replica set is one, a sharded deployment behind its mongos is one.

Want more than that? [hello@indexterity.alivlad.com](mailto:hello@indexterity.alivlad.com?subject=Indexterity%20commercial%20licence).
The copyright is held by one person, so a commercial licence is a conversation,
not a legal project.

## Notes

npm workspaces. Docker resolves to podman + `podman-compose` here; the compose
file works with either.
