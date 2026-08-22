/**
 * Static checks on SQL before it is staged for a human to confirm.
 *
 * query_database stages any SQL it is given, so an invalid statement is only
 * discovered when the owner clicks confirm and Postgres refuses. On 2026-08-22
 * three of the last four staged statements failed at confirm time, and every
 * one was detectable from the text alone:
 *
 *   CREATE OR REPLACE FUNCTION public.create_secure_user(...)
 *     -> permission denied for schema public          (twice)
 *   ... crypt(p_password, gen_salt('bf')) ...
 *     -> function crypt(unknown, text) does not exist
 *   CREATE POLICY "public_read_categories" ON categories ...
 *     -> policy "public_read_categories" already exists
 *
 * Confirm-time failure is the expensive kind: the owner is pulled in to approve
 * something that cannot work, and the agent only learns from a human relaying
 * the error back. This is the same shape as edge functions shipping unverified
 * before test_edge_function existed.
 *
 * BLOCKING vs WARNING is decided by whether the statement can EVER succeed on
 * this platform. A tenant role has no rights on `public`, so `public.` is a
 * certain failure and is refused outright. An unqualified pgcrypto call is
 * near-certainly wrong but a project could legitimately define its own
 * function of that name, so it warns rather than blocks -- a false block would
 * stop legitimate work, which is worse than a warning that gets ignored.
 */

/** pgcrypto helpers that live in the `extensions` schema, not on the search_path. */
const PGCRYPTO_FUNCTIONS = ['crypt', 'gen_salt', 'gen_random_bytes', 'digest', 'hmac'];

export interface SqlIssue {
  code: string;
  message: string;
}

export interface SqlPreflightResult {
  /** Certain failures. The statement must not be staged. */
  blocking: SqlIssue[];
  /** Probable mistakes worth surfacing, but not worth refusing over. */
  warnings: SqlIssue[];
}

/**
 * Blank out string literals, dollar-quoted bodies and comments, replacing each
 * with same-length padding so offsets are preserved.
 *
 * Without this, a policy NAMED "public_read_categories" or a comment mentioning
 * public.foo would trip the schema check. Function bodies are dollar-quoted and
 * routinely contain both, so they must be masked too.
 */
export function maskSqlLiterals(sql: string): string {
  let out = sql;
  const blank = (m: string) => ' '.repeat(m.length);

  // Dollar-quoted bodies first: they can contain quotes and comments.
  out = out.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, blank);
  // Single- and double-quoted strings/identifiers.
  out = out.replace(/'(?:[^']|'')*'/g, blank);
  out = out.replace(/"(?:[^"]|"")*"/g, blank);
  // Line and block comments.
  out = out.replace(/--[^\n]*/g, blank);
  out = out.replace(/\/\*[\s\S]*?\*\//g, blank);
  return out;
}

/**
 * pgcrypto calls written without the `extensions.` prefix.
 *
 * Exported because query_database has surfaced this warning since the
 * 2026-08-13 incident; this keeps one implementation rather than two that can
 * disagree.
 */
export function findUnqualifiedPgcryptoCalls(sql: string): string[] {
  const masked = maskSqlLiterals(sql);
  const found = new Set<string>();
  for (const fn of PGCRYPTO_FUNCTIONS) {
    // A call to `fn(` not preceded by a dot-qualifier of any kind.
    const re = new RegExp(String.raw`(?<![.\w])${fn}\s*\(`, 'gi');
    if (re.test(masked)) found.add(fn);
  }
  return [...found].sort();
}

export function preflightSql(sql: string): SqlPreflightResult {
  const blocking: SqlIssue[] = [];
  const warnings: SqlIssue[] = [];
  const masked = maskSqlLiterals(sql);

  // ── Blocking: objects qualified into the `public` schema ────────────────
  // A project's DB role owns only its own tenant schema. Anything qualified
  // `public.` fails with "permission denied for schema public", every time.
  if (/(?<![\w.])public\s*\.\s*[A-Za-z_"]/.test(masked)) {
    blocking.push({
      code: 'public_schema',
      message:
        'This SQL creates or references an object qualified as `public.` -- e.g. ' +
        '`CREATE FUNCTION public.foo(...)`. This project\'s database role has no rights on the ' +
        '`public` schema, so Postgres rejects it with "permission denied for schema public". ' +
        'Drop the `public.` prefix entirely: unqualified objects land in this project\'s own ' +
        'schema, which is what you want.',
    });
  }

  // ── Warning: pgcrypto without its schema ────────────────────────────────
  const unqualified = findUnqualifiedPgcryptoCalls(sql);
  if (unqualified.length > 0) {
    warnings.push({
      code: 'unqualified_pgcrypto',
      message:
        `Calls ${unqualified.map((f) => `"${f}"`).join(', ')} without the "extensions." prefix. ` +
        'pgcrypto is installed in the `extensions` schema, which is NOT on this role\'s ' +
        `search_path, so this fails at runtime with "function ${unqualified[0]} does not exist". ` +
        `Write it as extensions.${unqualified[0]}(...).`,
    });
  }

  // ── Warning: CREATE POLICY that will collide ────────────────────────────
  // Postgres has no CREATE POLICY IF NOT EXISTS, so re-running a migration
  // fails with "policy ... already exists" unless it drops first.
  const policyNames = [...sql.matchAll(/CREATE\s+POLICY\s+("?[\w\s-]+"?)/gi)].map((m) => m[1].trim());
  for (const name of policyNames) {
    const bare = name.replace(/^"|"$/g, '');
    const dropped = new RegExp(String.raw`DROP\s+POLICY\s+IF\s+EXISTS\s+"?${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?`, 'i');
    if (!dropped.test(sql)) {
      warnings.push({
        code: 'policy_no_drop',
        message:
          `CREATE POLICY ${name} has no matching DROP POLICY IF EXISTS. Postgres has no ` +
          '"CREATE POLICY IF NOT EXISTS", so this fails with "policy already exists" if it has ' +
          'ever run before. Add `DROP POLICY IF EXISTS ' + bare + ' ON <table>;` first.',
      });
    }
  }

  return { blocking, warnings };
}
