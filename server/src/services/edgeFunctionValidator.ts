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
import { simple as walkSimple } from 'acorn-walk';

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

  walkSimple(ast, {
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
  });

  return issues;
}
