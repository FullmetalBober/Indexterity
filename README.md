# Indexterity

Index dexterity for **MongoDB, PostgreSQL and SQL Server**. It watches your
indexes and manages them safely — drops the unused and redundant, merges
overlapping, extends prefixes, creates the missing — and proves the result in
freed bytes and latency.

**Read-only until you say otherwise.** The one irreversible step, a drop, is
gated behind an observe window, a pre-flight check and a read-latency regression
test. Everything before that is reversible, and the dashboard says which is
which.

**It cannot read your data.** Given credentials that can create users, it offers
to provision its own least-privilege one instead — `indexterity`, holding index
metadata and statistics and no read privilege at all. The server enforces that;
it is not a promise we make. The admin string is used once and never stored.

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
usage while the index keeps serving, and applying takes credentials you connect
deliberately. [Connecting a cluster](https://github.com/FullmetalBober/Indexterity/wiki/Connecting-a-cluster)
has the detail.

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

Want more than that? [hello@alivlad.com](mailto:hello@alivlad.com?subject=Indexterity%20commercial%20licence).
The copyright is held by one person, so a commercial licence is a conversation,
not a legal project.

## Notes

npm workspaces. Docker resolves to podman + `podman-compose` here; the compose
file works with either.
