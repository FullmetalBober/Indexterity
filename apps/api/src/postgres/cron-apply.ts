import { quoteIdent } from "./executor";

// Applying an index on PostgreSQL without an owner connection string (#332).
//
// PostgreSQL has no grantable index privilege: only a table's OWNER may alter
// its indexes, and an owner can always SELECT. So the scoped role this adapter
// provisions analyses and cannot apply, and applying used to mean the customer
// pasting an owner string we then hold sealed for the life of the cluster.
//
// A SECURITY DEFINER function owned by the table owner sidesteps that — but not
// for the statement this adapter issues. `CREATE INDEX CONCURRENTLY` is banned
// from every PL context outright, a SECURITY DEFINER procedure cannot do
// transaction control at all, and dblink escapes the function context only to
// deadlock against its own caller (CIC waits out every transaction that can see
// the table, including the one blocked reading the dblink result).
//
// pg_cron is the way through, and all of the following is measured on
// PostgreSQL 18.6 with pg_cron 1.6:
//
//   * a pg_cron job runs its command in a background worker OUTSIDE any
//     transaction block, so CIC is accepted there.
//   * a job scheduled from inside a SECURITY DEFINER function is recorded and
//     runs as the DEFINER, not the caller. That is the whole trick: the scoped
//     role calls the function, the build runs as the table owner.
//   * the scoped role therefore needs NO cron access — only EXECUTE on the
//     function. It still cannot read the table, cannot create an index directly,
//     and gets "permission denied for schema cron" if it tries to schedule
//     anything itself.
//   * no credential is stored anywhere. pg_cron's worker connects internally,
//     which is what makes this a better trade than the dblink variant, whose
//     function body has to carry the owner's password in world-readable pg_proc.
//
// Two constraints shape everything below.
//
// ONE STATEMENT PER JOB. A multi-statement pg_cron command IS wrapped in a
// transaction, and CIC is refused again inside it. So the job cannot unschedule
// itself and cleanup has to be a later tick's business — which is why a build
// here is asynchronous rather than awaited.
//
// THE FUNCTION LIVES IN THE CRON DATABASE, not in the database being indexed.
// `CREATE EXTENSION pg_cron` installs schema `cron` in exactly one database
// (`cron.database_name`, `postgres` by default) and it does not exist in any
// other — measured. A function in the app database therefore cannot call
// cron.schedule_in_database at all. So the scoped role dials the CRON database
// to ask for a build, and names the target database as an argument.

// Where the function lives and what it is called. A dedicated schema rather than
// `public`, because PostgreSQL 15 revoked CREATE on public from PUBLIC and the
// table owner is not a superuser — `permission denied for schema public` is what
// installing into public actually answers.
export const CRON_APPLY_SCHEMA = "indexterity";
export const CRON_APPLY_FUNCTION = "apply_index";
// Settling a build needs two more things the scoped role cannot do itself: read
// what the job did, and remove it. Both are SECURITY DEFINER for the same reason
// apply_index is — granting the scoped role cron access directly would undo the
// `permission denied for schema cron` refusal this whole route depends on.
export const CRON_STATUS_FUNCTION = "build_status";
export const CRON_FINISH_FUNCTION = "build_finish";

// The argument types, in order, as the signature a GRANT/REVOKE has to name.
const CRON_APPLY_SIGNATURE = "text,text,text,text,text[],text[],boolean,text[]";

function qualified(name: string): string {
  return `${quoteIdent(CRON_APPLY_SCHEMA)}.${quoteIdent(name)}`;
}

export function cronApplyQualifiedName(): string {
  return qualified(CRON_APPLY_FUNCTION);
}

// What the job last did, or no row when it has not run yet.
//
// A pg_cron job RECURS — it has no one-shot form — so a build that fails keeps
// failing on the schedule until something unschedules it, and a build that
// succeeds keeps re-running a no-op CREATE INDEX … IF NOT EXISTS forever. Both
// are why the tick has to settle the row rather than leaving the job in place.
export const CRON_STATUS_CALL_SQL = `SELECT status, return_message FROM ${qualified(CRON_STATUS_FUNCTION)}($1)`;
export const CRON_FINISH_CALL_SQL = `SELECT ${qualified(CRON_FINISH_FUNCTION)}($1) AS removed`;

// The last run of one job, by name. Takes a job NAME and nothing else, so there
// is no argument that could widen what it reads: a caller can ask about a job it
// already knows the name of, which is a name Indexterity chose.
function statusFunctionBody(): string {
  return `CREATE OR REPLACE FUNCTION ${qualified(CRON_STATUS_FUNCTION)}(job_name text)
RETURNS TABLE (status text, return_message text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $indexterity$
  SELECT d.status, d.return_message
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
   WHERE j.jobname = job_name
   ORDER BY d.start_time DESC
   LIMIT 1;
$indexterity$;`;
}

// Remove a job once its outcome has been recorded. Returns whether there was one
// to remove, so a second call is not an error — the tick may settle the same row
// twice if a write fails between unscheduling and updating it.
function finishFunctionBody(): string {
  return `CREATE OR REPLACE FUNCTION ${qualified(CRON_FINISH_FUNCTION)}(job_name text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $indexterity$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = job_name) THEN
    RETURN false;
  END IF;
  PERFORM cron.unschedule(job_name);
  RETURN true;
END
$indexterity$;`;
}

// How often a scheduled build is attempted until a tick unschedules it.
//
// pg_cron has no one-shot job, and a job cannot remove itself (one statement per
// job, see above), so every scheduled build recurs until something cancels it.
// The interval is a trade: short enough that a build starts promptly, long
// enough that a FAILING build is not hammering the server between ticks. A
// retry that finds the index already there is harmless — the statement carries
// IF NOT EXISTS — and the tick that sees `indisvalid` unschedules it.
export const CRON_JOB_SCHEDULE = "*/5 * * * *";

// The function body, and the whole security boundary of this feature.
//
// A SECURITY DEFINER function that interpolates caller-supplied text is a full
// escalation to the table owner, so nothing here accepts a SQL fragment:
//
//   * every identifier arrives as an element of a text[] and is quoted with %I.
//     The demonstrated escalation — passing `qty); CREATE TABLE app.pwned(x int`
//     as a column — becomes ONE quoted identifier, the job fails with `column
//     "…" does not exist`, and no table is created (measured).
//   * sort direction is a whitelist, not an identifier. `ASC; DROP TABLE …` is
//     refused by the function before anything is scheduled.
//   * `SET search_path = pg_catalog, pg_temp` is on the function, and every call
//     inside it is schema-qualified. Without this the whole thing is the textbook
//     SECURITY DEFINER attack.
//   * REVOKE ALL FROM PUBLIC precedes the GRANT, so EXECUTE is held by the scoped
//     role alone rather than by everyone who can connect.
//
// The partial-index predicate is deliberately absent. It is genuinely arbitrary
// SQL and there is no way to take it as an identifier, so a partial index stays
// out of scope for this route rather than being the one argument that reopens
// what the rest of the signature closes.
function functionBody(): string {
  return `CREATE OR REPLACE FUNCTION ${cronApplyQualifiedName()}(
  target_database text,
  target_schema   text,
  target_table    text,
  index_name      text,
  columns         text[],
  directions      text[],
  is_unique       boolean DEFAULT false,
  include_columns text[] DEFAULT '{}'
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $indexterity$
DECLARE
  cols text := '';
  incl text := '';
  stmt text;
  i    int;
BEGIN
  IF pg_catalog.array_length(columns, 1) IS DISTINCT FROM pg_catalog.array_length(directions, 1) THEN
    RAISE EXCEPTION 'columns and directions must be the same length';
  END IF;
  FOR i IN 1 .. pg_catalog.array_length(columns, 1) LOOP
    IF directions[i] NOT IN ('ASC', 'DESC') THEN
      RAISE EXCEPTION 'direction must be ASC or DESC, got %', directions[i];
    END IF;
    cols := cols || pg_catalog.format('%s%I %s',
              CASE WHEN i = 1 THEN '' ELSE ', ' END, columns[i], directions[i]);
  END LOOP;
  IF pg_catalog.array_length(include_columns, 1) > 0 THEN
    incl := pg_catalog.format(' INCLUDE (%s)',
              (SELECT pg_catalog.string_agg(pg_catalog.quote_ident(c), ', ')
                 FROM pg_catalog.unnest(include_columns) c));
  END IF;
  stmt := pg_catalog.format('CREATE%s INDEX CONCURRENTLY IF NOT EXISTS %I ON %I.%I (%s)%s',
            CASE WHEN is_unique THEN ' UNIQUE' ELSE '' END,
            index_name, target_schema, target_table, cols, incl);
  RETURN cron.schedule_in_database(index_name, '${CRON_JOB_SCHEDULE}', stmt, target_database);
END
$indexterity$;`;
}

// The one-time setup, for the operator to read and run. Handed over rather than
// executed, exactly like the GRANT snippets the connect form already hands out
// and like the drop statements the disconnect screen shows: everything here
// needs privileges this product deliberately does not hold.
//
// Split into the part that needs a superuser and a restart, and the part the
// table owner runs — because they are usually different people, and the restart
// is the only genuinely expensive step.
export function cronApplySetup(owner: string, scopedRole: string): string {
  const ownerIdent = quoteIdent(owner);
  const roleIdent = quoteIdent(scopedRole);
  return [
    "-- 1. As a superuser, ONCE per server. pg_cron is a shared library, so this",
    "--    step needs a restart; nothing after it does.",
    "--    Add to postgresql.conf (or the parameter group on a managed provider):",
    "--      shared_preload_libraries = 'pg_cron'",
    "--      cron.database_name = 'postgres'",
    "--    Restart, then in the cron database:",
    "CREATE EXTENSION IF NOT EXISTS pg_cron;",
    "",
    "-- 2. As a superuser, in the cron database. The owner needs to be able to",
    "--    schedule; schedule_in_database is superuser-only until it is granted,",
    "--    and granting it is what keeps a superuser out of every later apply.",
    `GRANT USAGE ON SCHEMA cron TO ${ownerIdent};`,
    "GRANT EXECUTE ON FUNCTION cron.schedule_in_database(text,text,text,text,text,boolean)",
    `  TO ${ownerIdent};`,
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(CRON_APPLY_SCHEMA)} AUTHORIZATION ${ownerIdent};`,
    `GRANT USAGE ON SCHEMA ${quoteIdent(CRON_APPLY_SCHEMA)} TO ${roleIdent};`,
    "",
    `-- 3. The function itself, OWNED BY ${owner} — the role that owns the tables.`,
    "--    Ownership is the point: the function runs as its definer, so that is",
    "--    the role every build will run as, and it must own the tables in each",
    "--    database to be indexed.",
    "--",
    "--    SET ROLE rather than a comment saying 'run this as the owner'. Pasted",
    "--    whole by a superuser, a bare CREATE FUNCTION here would be owned by the",
    "--    SUPERUSER, and every build would then run with far more privilege than",
    "--    this design asks for. Running it as the owner already is a no-op.",
    `SET ROLE ${ownerIdent};`,
    functionBody(),
    statusFunctionBody(),
    finishFunctionBody(),
    "RESET ROLE;",
    "",
    "-- 4. EXECUTE to the scoped role and nobody else. It needs no cron access of",
    `--    its own: ${scopedRole} still cannot read a table, cannot create an index`,
    "--    directly, and cannot schedule anything.",
    `REVOKE ALL ON FUNCTION ${cronApplyQualifiedName()}(${CRON_APPLY_SIGNATURE}) FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${cronApplyQualifiedName()}(${CRON_APPLY_SIGNATURE}) TO ${roleIdent};`,
    `REVOKE ALL ON FUNCTION ${qualified(CRON_STATUS_FUNCTION)}(text) FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${qualified(CRON_STATUS_FUNCTION)}(text) TO ${roleIdent};`,
    `REVOKE ALL ON FUNCTION ${qualified(CRON_FINISH_FUNCTION)}(text) FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${qualified(CRON_FINISH_FUNCTION)}(text) TO ${roleIdent};`,
  ].join("\n");
}

// Whether this connection can reach the apply function: it exists, it is
// SECURITY DEFINER, and the connected role may execute it.
//
// All three are asked of the catalog rather than assumed from pg_cron being
// installed, because the interesting failure is a half-done setup — the
// extension present and the function never created, or created and never
// granted. `has_function_privilege` answers the last part for the role we are
// actually connected as, which is the only one that matters.
export const CRON_APPLY_PROBE_SQL = `SELECT p.prosecdef AS security_definer,
       pg_catalog.has_function_privilege(p.oid, 'EXECUTE') AS executable,
       pg_catalog.pg_get_userbyid(p.proowner) AS owner
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = $1 AND p.proname = $2
 LIMIT 1`;

export const CRON_APPLY_PROBE_PARAMS = [CRON_APPLY_SCHEMA, CRON_APPLY_FUNCTION];

export interface CronApplyRoute {
  readonly installed: boolean;
  readonly executable: boolean;
  readonly owner: string | null;
}

export function readCronApplyProbe(
  rows: readonly { security_definer: boolean; executable: boolean; owner: string }[],
): CronApplyRoute {
  const row = rows[0];
  if (row === undefined) return { installed: false, executable: false, owner: null };
  // A function that is not SECURITY DEFINER would run as the CALLER, which is
  // the scoped role, which cannot create an index — so it is present but useless
  // and reported as not installed rather than as a puzzle at the first apply.
  if (!row.security_definer) return { installed: false, executable: false, owner: row.owner };
  return { installed: true, executable: row.executable, owner: row.owner };
}

// Which database pg_cron keeps its job tables in, or null when pg_cron is not
// loaded at all.
//
// `cron.database_name` is a GUC the extension's shared library defines, so it
// answers both questions at once and needs no privilege: any role can SHOW it
// from any database (measured as the scoped role from a database that has no
// `cron` schema), and a server without pg_cron in shared_preload_libraries
// answers `unrecognized configuration parameter` instead.
//
// That matters because the function lives in the cron database and the adapter
// is pooled per database — so this is how a session holding a connection to the
// application's database finds out where to ask for a build.
export const CRON_DATABASE_GUC = "cron.database_name";

export function isUnrecognizedGuc(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unrecognized configuration parameter/i.test(message);
}

// The call that asks for a build. Every argument is bound, never interpolated:
// the function quotes each identifier with %I internally, and binding is what
// keeps this side from having to think about quoting at all.
export const CRON_APPLY_CALL_SQL = `SELECT ${cronApplyQualifiedName()}($1, $2, $3, $4, $5, $6, $7, $8) AS jobid`;

// Sort direction as the function's whitelist expects it. The executor speaks
// 1/-1 like every other adapter; the function refuses anything that is not
// exactly ASC or DESC, so this is the only place the two vocabularies meet.
export function cronDirections(keys: Record<string, 1 | -1>): string[] {
  return Object.values(keys).map((direction) => (direction === -1 ? "DESC" : "ASC"));
}
