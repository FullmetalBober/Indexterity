import type { ClusterEngine } from "@repo/contracts";

// What a connection string looks like, per engine, in the few words an input has
// room for.
//
// The api ships the authoritative hints — each adapter carries a
// `connStringHint` and the connect form prints them in full underneath the field,
// where there is room for `mssql://user:password@host:1433 or Server=host;User
// Id=…;Password=…`. These are the shortened forms for the placeholder INSIDE the
// field, and they exist here rather than inline because two screens ask the same
// question and got different answers: the connect form named two of the three
// supported engines, and the rotate field on a cluster's settings said
// `mongodb://` on every cluster — including a PostgreSQL one, where it is the
// field confidently telling an owner the wrong thing about their own database.
//
// Typed as a full Record, so the next adapter cannot ship without wording. That
// is the same reason SCOPED_USER_COPY in connect-cluster-form.tsx is a full
// Record: a partial map with a fallback let a Postgres cluster inherit MongoDB's
// sentences for a release.

// A fuller example, for a field with room and no engine chosen yet.
const EXAMPLE: Record<ClusterEngine, string> = {
  MONGODB: "mongodb://user:pass@host:27017",
  POSTGRESQL: "postgres://user:pass@host:5432/db",
  MSSQL: "Server=host;User Id=sa;Password=…",
};

/**
 * How a string for THIS engine begins — short enough to sit inside a sentence
 * like "new … connection string".
 *
 * SQL Server carries two forms because one of them has no scheme at all: the ADO
 * `Server=host;…` list is what its own tooling copies out, so naming only
 * `mssql://` would look like the other form is unsupported.
 */
export const CONNECTION_SCHEME: Record<ClusterEngine, string> = {
  MONGODB: "mongodb://",
  POSTGRESQL: "postgres://",
  MSSQL: "mssql:// or Server=…",
};

/**
 * For the connect form, where the field is empty and nothing has been pasted, so
 * no engine is known yet — not even from the scheme sniffer, which needs a string
 * to sniff.
 *
 * All three, and that is the point rather than tidiness: naming a subset is
 * exactly how this field came to imply MongoDB-only (#239), and it had drifted
 * back to naming two after PostgreSQL shipped.
 */
export const ANY_CONNECTION_EXAMPLE = `${EXAMPLE.MONGODB}  ·  ${EXAMPLE.POSTGRESQL}  ·  ${EXAMPLE.MSSQL}`;
