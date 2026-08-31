// AST-based static validation for edge function source code, replacing a
// 3-regex text scan that never checked for `.constructor` access -- the
// exact primitive a sandbox-escape chain (Object.constructor.constructor(...))
// needs, and which is trivially reachable in any string-scan-only check
// (e.g. via string concatenation, bracket notation, whitespace tricks).
//
// This is defense-in-depth, not the sole protection: the real fix is
// isolated-vm giving generated code its own separate V8 isolate (see
// functionRunner.service.ts) rather than a shared-realm vm.createContext.
// Even so, catching an obvious escape attempt here gives the agent a clear
// error to fix instead of a cryptic runtime failure, and blocks tampered
// DB rows that bypassed write_edge_function's own check.
import * as acorn from 'acorn';
import { ancestor as walkAncestor } from 'acorn-walk';

export interface ValidationIssue {
  message: string;
}

const BANNED_IDENTIFIERS = new Set([
  'require',
  'process',
  'global',
  'globalThis',
  'Function', // the Function constructor -- an alternate route to eval-like code execution
  'eval',
  'module',
  'exports',
  '__dirname',
  '__filename',
]);

function isConstructorAccess(node: acorn.MemberExpression): boolean {
  if (!node.computed) {
    return node.property.type === 'Identifier' && node.property.name === 'constructor';
  }
  // Bracket notation with a literal 'constructor' key ("obj['constructor']").
  return node.property.type === 'Literal' && node.property.value === 'constructor';
}

const PASSWORD_NAME_RE = /password/i;
// crypt/gen_salt (pgcrypto, the pattern app-builder.prompt.ts's rule 5 teaches),
// bcrypt/argon2/scrypt (JS-side hashing libs), or a generic "hash" call --
// any of these means the value passed through *some* hashing step, which is
// all this check can verify statically (it can't confirm the hash is strong).
const HASH_CALL_RE = /crypt|hash|bcrypt|argon2|scrypt|verify/i;

function propertyKeyName(node: acorn.Property): string | null {
  if (node.key.type === 'Identifier') return node.key.name;
  if (node.key.type === 'Literal' && typeof node.key.value === 'string') return node.key.value;
  return null;
}

function memberChainName(node: acorn.Expression): string {
  // Flattens `a.b.c` / `a['b']['c']` into "a.b.c" for a regex test against
  // the whole chain -- catches `extensions.crypt(...)` as well as `crypt(...)`.
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return `${memberChainName(node.object as acorn.Expression)}.${node.property.name}`;
  }
  return '';
}

function unwrapAwait(node: acorn.Node): acorn.Node {
  return node.type === 'AwaitExpression' ? (node as acorn.AwaitExpression).argument : node;
}

function isHashCall(rawNode: acorn.Node): boolean {
  const node = unwrapAwait(rawNode);
  if (node.type !== 'CallExpression') return false;
  const call = node as acorn.CallExpression;
  const callee = call.callee;
  if (callee.type === 'Identifier' && HASH_CALL_RE.test(callee.name)) return true;
  if (callee.type === 'MemberExpression' && HASH_CALL_RE.test(memberChainName(callee as acorn.Expression))) return true;
  // db.rpc('hash_password', ...) / db.rpc('verify_password', ...) -- calling a
  // named Postgres function is this codebase's other idiomatic hashing shape
  // (app-builder.prompt.ts's own comment on db.rpc), where the hash-ness lives
  // in the STRING ARGUMENT naming the function, not in the `db.rpc` callee itself.
  const calleeChain = callee.type === 'MemberExpression' ? memberChainName(callee as acorn.Expression)
    : callee.type === 'Identifier' ? callee.name : '';
  if (/\brpc$/.test(calleeChain)) {
    const firstArg = call.arguments[0];
    if (firstArg && firstArg.type === 'Literal' && typeof firstArg.value === 'string' && HASH_CALL_RE.test(firstArg.value)) {
      return true;
    }
  }
  return false;
}

// True if `node` sits (at any depth) inside the argument list of a call this
// module already recognizes as a hash/verify call -- e.g. the `{ password,
// hash: user.password_hash }` object literal passed to
// `db.rpc('verify_password', {...})`. Forwarding a password INTO a
// recognized hash/verify call is the point of that call, not a defect.
function isInsideHashCallArgs(ancestors: acorn.Node[]): boolean {
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === 'CallExpression' && isHashCall(a)) return true;
    // Stop widening once we leave the immediate argument-expression chain
    // (i.e. once we hit a statement), so this doesn't reach across unrelated
    // sibling code that happens to share a hash call somewhere in the file.
    if (/Statement$/.test(a.type) || a.type === 'Program') break;
  }
  return false;
}

function isPasswordLike(name: string): boolean {
  return PASSWORD_NAME_RE.test(name);
}

/**
 * Validates edge function source against the sandbox contract. `code` is the
 * user's function BODY (not yet wrapped in the async IIFE) -- same input
 * write_edge_function.ts and functionRunner.service.ts both work with.
 * Returns an empty array when the code is clean.
 */
export function validateEdgeFunctionCode(code: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  let ast: acorn.Node;
  try {
    // sourceType: 'script' (not 'module') means import/export ARE syntax
    // errors at parse time -- acorn rejects them for us, no separate check needed.
    ast = acorn.parse(`(async function __fn__(params, db, ecg, fetch, console, secrets) {\n${code}\n})`, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: false,
    });
  } catch (err) {
    return [{ message: `Syntax error: ${(err as Error).message}` }];
  }

  walkAncestor(ast, {
    VariableDeclarator(node: acorn.VariableDeclarator) {
      // The single most common data bug in generated functions: destructuring
      // { data, error } from a db.* call. The runner's db.select/insert/update/
      // delete/rpc return the PostgREST result DIRECTLY (a bare array or row),
      // never a supabase-js { data, error } envelope, and they THROW on failure
      // rather than returning an error field. So `const { data, error } =
      // await db.select('t')` leaves data === undefined on every call, and
      // `return data || []` ships an empty result while the table is full.
      // Shipped live in cqjobs (get-categories/get-job-types/get-gigs, all
      // returning [] against a populated DB, 2026-08-31). Every gate passed it:
      // valid syntax, no banned identifier, clean AST.
      if (
        node.id.type === 'ObjectPattern' &&
        node.init != null
      ) {
        const call = unwrapAwait(node.init);
        if (call.type === 'CallExpression') {
          const callee = (call as acorn.CallExpression).callee;
          if (
            callee.type === 'MemberExpression' &&
            memberChainName(callee.object as acorn.Expression) === 'db'
          ) {
            const keys = node.id.properties
              .map((pr) => (pr.type === 'Property' ? propertyKeyName(pr as acorn.Property) : null))
              .filter((k): k is string => k !== null);
            if (keys.includes('data') || keys.includes('error')) {
              const method = callee.property.type === 'Identifier' ? callee.property.name : 'select';
              issues.push({
                message: `Do not destructure { data, error } from db.${method}(). The db helper returns the ` +
                  `result directly -- a bare array or row, not a { data, error } envelope -- and throws on failure. ` +
                  `As written, data is always undefined and the function returns nothing. Use ` +
                  `\`const rows = await db.${method}(...)\` and return \`rows\`; wrap in try/catch if you need to ` +
                  `handle an error.`,
              });
            }
          }
        }
      }
    },
    Identifier(node: acorn.Identifier) {
      if (BANNED_IDENTIFIERS.has(node.name)) {
        issues.push({
          message: `"${node.name}" is not available in the sandbox. ` +
            (node.name === 'process'
              ? 'Read secrets via the injected `secrets` object (e.g. secrets.MY_API_KEY), not process.env.'
              : 'Use the injected `db`, `secrets`, `fetch`, `ecg` helpers instead.'),
        });
      }
    },
    MemberExpression(node: acorn.MemberExpression) {
      if (isConstructorAccess(node)) {
        issues.push({
          message: '.constructor access is not allowed -- this is the exact primitive sandbox-escape attempts use ' +
            '(e.g. obj.constructor.constructor(...)). Rewrite without touching .constructor.',
        });
      }
    },
    WithStatement() {
      issues.push({ message: '`with` statements are not allowed.' });
    },
    ImportExpression() {
      issues.push({ message: 'Dynamic import() is not available in the sandbox.' });
    },
    // Plaintext-password detection: a password-named object field assigned a
    // value that never passed through a hash call, e.g. `password_hash: password`
    // (this exact pattern shipped live in a real project -- see CardPro
    // auth-login.js/auth-signup.js, 2026-08-08). Heuristic, not proof of a
    // hash's strength: it only confirms *some* crypt/hash/bcrypt call is in
    // the value expression. In practice this should rarely fire at all --
    // app-builder.prompt.ts's rule 5 now tells the agent to route auth
    // through the platform's own Auth connection instead of ever hashing or
    // storing a password in generated code (this database has no pgcrypto,
    // and the sandbox has no crypto global or npm packages -- there's no
    // safe way to hash one here regardless).
    //
    // Needs `ancestor` (not `simple`) to see the immediate parent: acorn's AST
    // uses the same "Property" node type for real object-literal construction
    // (`{ password_hash: x }`, ObjectExpression parent) AND destructuring
    // (`const { password } = params`, ObjectPattern parent) -- a `simple` walk
    // can't tell them apart and false-positives on every ordinary
    // `const { email, password } = params;` line (which is how nearly every
    // real password-handling function starts).
    Property(rawNode: acorn.Node, _state: unknown, ancestors: acorn.Node[]) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent || parent.type !== 'ObjectExpression') return; // skip destructuring patterns
      const node = rawNode as unknown as acorn.Property;
      const keyName = propertyKeyName(node);
      if (!keyName || !isPasswordLike(keyName)) return;
      if (isHashCall(node.value)) return;
      if (isInsideHashCallArgs(ancestors)) return; // forwarded into a recognized hash/verify call
      issues.push({
        message: `Field "${keyName}" is assigned a value that doesn't pass through a hash call ` +
          '(crypt/bcrypt/etc). Storing or forwarding a raw password is a security defect. This database/sandbox ' +
          'has no hashing primitive available (no pgcrypto, no Web Crypto, no npm packages) -- do not hand-roll ' +
          'one. Route login/signup/password verification through the platform\'s Auth connection instead of a ' +
          'custom password table (see the password-handling rule).',
      });
    },
    // Plaintext-password comparison: `user.password_hash !== password` (also
    // shipped live in the same incident) compares a stored hash against a raw
    // value with no hash call anywhere in the comparison.
    BinaryExpression(node: acorn.BinaryExpression) {
      if (!['===', '!==', '==', '!='].includes(node.operator)) return;
      const leftName = node.left.type === 'Identifier' ? node.left.name
        : node.left.type === 'MemberExpression' ? memberChainName(node.left as acorn.Expression) : '';
      const rightName = node.right.type === 'Identifier' ? node.right.name
        : node.right.type === 'MemberExpression' ? memberChainName(node.right as acorn.Expression) : '';
      const touchesPassword = isPasswordLike(leftName) || isPasswordLike(rightName);
      if (!touchesPassword) return;
      if (isHashCall(node.left) || isHashCall(node.right)) return;
      issues.push({
        message: 'Comparing a password/password_hash field without a hash call in the comparison -- this compares ' +
          'a stored hash against a raw value (or two raw values) directly. This database/sandbox has no hashing ' +
          'primitive available -- route login/signup through the platform\'s Auth connection instead of ' +
          'verifying passwords yourself.',
      });
    },
    // `db.*` call-shape validation (orchestration audit, 2026-08-09): the db
    // helper's API is deliberately similar-looking to Supabase's real client
    // (db.select/insert/update/delete/count/rpc) but is NOT chainable and
    // does NOT accept a Supabase/Prisma-style options object -- confirmed
    // live across 3 separate real incidents in one night (admin-auth,
    // admin-login used Supabase-style `.eq().single()` chaining; get-latest-
    // posts then invented a THIRD wrong shape, a `{ columns, order, limit }`
    // options object, on its very next "fix" attempt for the same function).
    // The model defaults to far more common training-data patterns (real
    // Supabase client, generic ORM options objects) unless something
    // mechanically stops it -- prompt text alone did not, three times.
    CallExpression(node: acorn.CallExpression) {
      const DB_METHODS = new Set(['select', 'insert', 'update', 'delete', 'count', 'rpc']);
      // Real Promise prototype methods -- db.* returns a Promise (per its own
      // documented contract), so `.then()/.catch()/.finally()` chained onto
      // an UN-awaited call is completely legitimate (confirmed: this exact
      // fire-and-forget pattern, `db.update(...).catch(err => ...)`, is
      // already live in this codebase's own real functions). Only a
      // query-builder-shaped method name (.eq, .from, .single, .order, .in,
      // .select-after-insert, etc) is the actual tell.
      const PROMISE_METHODS = new Set(['then', 'catch', 'finally']);
      // Case 1: any further method call chained directly onto a db.* call's
      // result (`db.select(...).eq(...)`, `.from(...)`, `.single()`, etc).
      // 100% reliable, zero ambiguity: db.* always returns a plain array/
      // object/promise, never a chainable query builder, so ANY non-Promise
      // call chained onto one is categorically invalid regardless of name.
      if (
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        !(node.callee.property.type === 'Identifier' && PROMISE_METHODS.has(node.callee.property.name))
      ) {
        const inner = node.callee.object;
        if (
          inner.type === 'CallExpression' &&
          inner.callee.type === 'MemberExpression' &&
          !inner.callee.computed &&
          inner.callee.object.type === 'Identifier' &&
          inner.callee.object.name === 'db' &&
          inner.callee.property.type === 'Identifier' &&
          DB_METHODS.has(inner.callee.property.name)
        ) {
          const chainedMethod = node.callee.property.type === 'Identifier' ? node.callee.property.name : '(computed)';
          issues.push({
            message: `db.${inner.callee.property.name}(...).${chainedMethod}(...) is not valid -- db.* calls are NOT ` +
              `chainable (they return a plain array/object/promise directly, never a query builder). This looks like ` +
              `real Supabase client syntax, but this platform's db helper has a different signature: ` +
              `db.select(table, columns?, filter?, extraOps?), db.insert(table, data), db.update(table, patch, filter), ` +
              `db.delete(table, filter), db.count(table, filter?), db.rpc(fnName, args). Pass filtering/sorting/limits ` +
              `as arguments to the call itself, not as chained methods.`,
          });
        }
      }
      // Case 2: db.select(table, { columns: [...], order: {...}, limit: N })
      // -- a Prisma/generic-ORM-shaped options object where none of those
      // keys are valid. db.select's real 2nd arg is EITHER an array of
      // column names OR a filter object whose keys are actual column names
      // for equality matching -- "columns"/"order"/"limit"/"sort" as literal
      // keys is the tell that a filter object is standing in for an options
      // object that doesn't exist in this API.
      if (
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'db' &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === 'select' &&
        node.arguments.length === 2 &&
        node.arguments[1].type === 'ObjectExpression'
      ) {
        const RESERVED_OPTION_KEYS = new Set(['columns', 'order', 'limit', 'sort', 'orderby', 'select']);
        const objArg = node.arguments[1] as acorn.ObjectExpression;
        const suspiciousKeys = objArg.properties
          .map((p) => (p.type === 'Property' ? propertyKeyName(p) : null))
          .filter((k): k is string => k !== null && RESERVED_OPTION_KEYS.has(k.toLowerCase()));
        if (suspiciousKeys.length > 0) {
          issues.push({
            message: `db.select's 2nd argument here uses key(s) [${suspiciousKeys.join(', ')}] that look like an ` +
              `options object (columns/order/limit), but db.select does not accept one -- its real signature is ` +
              `db.select(table, filter?) OR db.select(table, columns, filter?, extraOps?) as SEPARATE positional ` +
              `arguments: columns is an array of column names (2nd arg), filter is a plain equality object keyed by ` +
              `actual column names (3rd arg, or 2nd if no columns array), and sort/limit go in extraOps (4th arg, ` +
              `per-column: { ascending: false }). A filter object's keys must be real column names, never the ` +
              `literal words "columns"/"order"/"limit".`,
          });
        }
      }
    },
  });

  return issues;
}
