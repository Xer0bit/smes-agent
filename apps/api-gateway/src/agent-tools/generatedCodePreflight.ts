/**
 * Two mistakes the agent keeps making that every existing gate lets through.
 *
 * Both are valid TypeScript. esbuild parses them, the AST reflection check
 * passes them, and typeCheckProject runs after the response and gates nothing,
 * so they reach a customer's live preview and throw at runtime. Both were
 * observed in production on 2026-08-30, in two different projects, and one of
 * them came back within two hours of being hand-repaired:
 *
 *   const functionsApiUrl = undefined as string | undefined;
 *   return result.data as T;   // runner returns { result, logs, durationMs }
 *
 * The prompt already documents the correct envelope in detail
 * (app-builder.prompt.ts) and even predicts the exact symptom, "x.map is not a
 * function". Instruction was not enough; this refuses the write instead.
 *
 * Both rules are deliberately narrow. A false block stops legitimate work,
 * which is worse than a miss, so each requires two independent signals rather
 * than one suggestive pattern.
 */

export interface GeneratedCodeIssue {
  code: 'env_hardcoded_undefined' | 'edge_invoke_data_envelope';
  line: number;
  message: string;
}

/** Names that carry configuration, where a literal `undefined` is never intended. */
const CONFIG_NAME_RE = /(url|key|token|secret|endpoint|apikey)$/i;

/** `const x = undefined` / `let x = undefined as string | undefined` */
const UNDEFINED_ASSIGN_RE = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*undefined\b/;

/** Captures the variable a JSON body was parsed into: `const result = await res.json()` */
const JSON_BODY_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+[A-Za-z_$][\w$]*\.json\s*\(\s*\)/;

/**
 * Does this file talk to the tenant edge-function runner?
 *
 * Required before flagging `.data`, because the Supabase client legitimately
 * returns `{ data, error }` and that must never be blocked. The runner is
 * reached over fetch to an `/invoke` path, never through the supabase client.
 */
function callsEdgeFunctionRunner(source: string): boolean {
  return /\/invoke\b/.test(source) || /VITE_FUNCTIONS_API_URL/.test(source);
}

export function inspectGeneratedCode(path: string, source: string): GeneratedCodeIssue[] {
  if (!/\.(ts|tsx|js|jsx)$/i.test(path)) return [];

  const issues: GeneratedCodeIssue[] = [];
  const lines = source.split('\n');
  const jsonBodyVars = new Set<string>();
  const isRunnerFile = callsEdgeFunctionRunner(source);

  for (const line of lines) {
    const m = JSON_BODY_RE.exec(line);
    if (m) jsonBodyVars.add(m[1]);
  }

  lines.forEach((line, i) => {
    const lineNo = i + 1;

    // ── Rule 1: a config value hardcoded to `undefined` ────────────────────
    // Two signals: the literal assignment AND a name that carries config.
    // `let cached = undefined` is normal and must stay allowed.
    const assign = UNDEFINED_ASSIGN_RE.exec(line);
    if (assign && CONFIG_NAME_RE.test(assign[1])) {
      issues.push({
        code: 'env_hardcoded_undefined',
        line: lineNo,
        message:
          `"${assign[1]}" is assigned the literal \`undefined\`. A config value must come from ` +
          `import.meta.env (VITE_DB_API_URL, VITE_DB_ANON_KEY, VITE_FUNCTIONS_API_URL) -- these are ` +
          `already set for this project; a VITE_SUPABASE_* value exists only if the owner saved one. ` +
          `As written the module throws at import time and the whole app shows an error screen.`,
      });
    }

    // ── Rule 2: reading `.data` off an edge-function response ──────────────
    // Two signals: the file calls the runner AND `.data` is read from the
    // variable a JSON body was parsed into. Supabase's own `{ data, error }`
    // never matches, because it is not assigned from `.json()`.
    if (isRunnerFile) {
      for (const v of jsonBodyVars) {
        if (new RegExp(`\\b${v}\\.data\\b`).test(line)) {
          issues.push({
            code: 'edge_invoke_data_envelope',
            line: lineNo,
            message:
              `"${v}.data" is undefined. The edge-function runner wraps every return as ` +
              `{ result, logs, durationMs } -- the payload is under \`result\`, never \`data\`. ` +
              `Use ${v}.result. Reading .data yields undefined, and a cast like \`as T\` hides ` +
              `that until something calls .map on it at runtime.`,
          });
          break;
        }
      }
    }
  });

  return issues;
}
