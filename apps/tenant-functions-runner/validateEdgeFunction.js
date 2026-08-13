// Sandbox-escape static validation for the VPS5 execution path.
//
// This is the SECURITY subset of api-gateway's edgeFunctionValidator.ts --
// only the sandbox-escape guards (banned globals, `.constructor` access,
// `with`, dynamic import). The db-call-shape and plaintext-password checks
// from that file are quality-of-generation guards that already run at WRITE
// time in write_edge_function.ts; the execute path here only needs to stop a
// tampered or malicious function body from escaping the vm realm.
//
// Defense-in-depth, NOT the whole answer: the complete fix is isolated-vm (a
// separate V8 heap, as functionRunner.service.ts uses), which VPS5 does not
// have installed. Combined with removing host-intrinsic injection from the vm
// context (see runEdgeFunction.js), this closes the reachable escape vectors
// -- `Object.constructor.constructor(...)`, `Function(...)`, `globalThis`,
// `process`, `require` -- and gives a clear error instead of a silent RCE.
import * as acorn from 'acorn';
import { simple as walkSimple } from 'acorn-walk';

const BANNED_IDENTIFIERS = new Set([
  'require', 'process', 'global', 'globalThis',
  'Function', // the Function constructor -- eval-equivalent code execution
  'eval', 'module', 'exports', '__dirname', '__filename',
]);

function isConstructorAccess(node) {
  if (!node.computed) {
    return node.property.type === 'Identifier' && node.property.name === 'constructor';
  }
  // Bracket notation with a literal 'constructor' key ("obj['constructor']").
  return node.property.type === 'Literal' && node.property.value === 'constructor';
}

// A computed member key built from string concatenation or a template literal
// (`obj['con'+'structor']`, `obj[`cons${x}`]`) is the standard way to dodge a
// literal-key check and reach `.constructor` on an injected host function
// (fetch/crypto/console), which still routes to the host Function constructor.
// Real generated functions index with a plain variable or literal
// (`row[col]`, `data['id']`); a *constructed* key has no legitimate use here,
// so rejecting it closes the obfuscation route without touching normal access.
function isConstructedComputedKey(node) {
  if (!node.computed) return false;
  const p = node.property;
  if (p.type === 'TemplateLiteral') return true;
  if (p.type === 'BinaryExpression' && p.operator === '+') return true;
  return false;
}

/**
 * Returns an array of {message} issues; empty means the code is clean.
 * `code` is the raw function BODY (same input write_edge_function.ts works with).
 */
export function validateEdgeFunction(code) {
  const issues = [];
  let ast;
  try {
    // sourceType:'script' makes import/export parse errors -- acorn rejects
    // them for us. Wrapping matches how runEdgeFunction actually executes it.
    ast = acorn.parse(`(async function __fn__(params, db, ecg, fetch, console, secrets) {\n${code}\n})`, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: false,
    });
  } catch (err) {
    return [{ message: `Syntax error: ${err.message}` }];
  }

  walkSimple(ast, {
    Identifier(node) {
      if (BANNED_IDENTIFIERS.has(node.name)) {
        issues.push({
          message: `"${node.name}" is not available in the sandbox.` +
            (node.name === 'process'
              ? ' Read secrets via the injected `secrets` object, not process.env.'
              : ' Use the injected db/secrets/fetch/ecg helpers instead.'),
        });
      }
    },
    MemberExpression(node) {
      if (isConstructorAccess(node)) {
        issues.push({
          message: '.constructor access is not allowed -- it is the exact primitive sandbox-escape ' +
            'chains use (obj.constructor.constructor(...)). Rewrite without touching .constructor.',
        });
      } else if (isConstructedComputedKey(node)) {
        issues.push({
          message: 'Computed property access with a built-up key (e.g. obj[\'a\'+\'b\'] or obj[`x${y}`]) is not ' +
            'allowed -- it is used to obfuscate sandbox-escape access. Index with a plain variable or string literal.',
        });
      }
    },
    WithStatement() {
      issues.push({ message: '`with` statements are not allowed.' });
    },
    ImportExpression() {
      issues.push({ message: 'Dynamic import() is not available in the sandbox.' });
    },
  });

  return issues;
}
