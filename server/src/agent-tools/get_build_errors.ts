/**
 * get_build_errors tool — query the Vite preview service for current build errors.
 *
 * This gives the agent the exact, real error messages from the live Vite dev server
 * instead of guessing from file contents. Call this FIRST when asked to fix an error.
 */
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';

// ─── Circuit breaker: detect repeated identical error signatures per project ──
// Entries expire after MAX_ERROR_HISTORY_AGE_MS to avoid cross-run leakage.
const MAX_ERROR_HISTORY_AGE_MS = 10 * 60 * 1000; // 10 minutes
const errorHistory = new Map<string, { signature: string; count: number; ts: number }>();

const PREVIEW_SERVICE_URL =
  process.env.PREVIEW_SERVICE_URL ||
  process.env.VITE_PREVIEW_SERVICE_URL ||
  'http://localhost:3001';

const schema = z.object({
  projectId: z.string().describe('The project ID to check for build errors'),
});

export const getBuildErrorsTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'get_build_errors',
  description:
    'Query the live Vite preview server for current build errors. Returns exact error messages with file paths and line numbers. ' +
    'When to call: (1) FIRST at the start of a fix run — never guess at errors, ' +
    '(2) ONCE after ALL files are written in a batch — not after each individual file write. ' +
    '(3) When the user explicitly reports a broken state. ' +
    'LIMIT: Maximum 3 calls per run. After that, finish your response and stop.',
  inputSchema: schema,
  getConsentPreview: (args) => `Get build errors for project ${args.projectId}`,

  execute: async (args, ctx: AgentContext) => {
    const projectId = args.projectId || ctx.projectId;
    const url = `${PREVIEW_SERVICE_URL}/preview/${projectId}/status`;

    // ─── Per-run call cap: prevent infinite error-check loops ────────────────
    ctx.buildErrorCallCount = (ctx.buildErrorCallCount ?? 0) + 1;
    const MAX_CALLS_PER_RUN = 3;
    if (ctx.buildErrorCallCount > MAX_CALLS_PER_RUN) {
      return (
        `STOP: get_build_errors has been called ${ctx.buildErrorCallCount} times this run (limit is ${MAX_CALLS_PER_RUN}). ` +
        'You are in an error-fix loop. Do NOT call get_build_errors again. ' +
        'End your response now. The preview will be updated automatically when your response finishes.'
      );
    }

    // Flush pending writes to the preview service before checking errors.
    // Without this the Vite dev server would report stale errors from before
    // the agent's latest changes.
    if (ctx.pendingPreviewFiles && ctx.pendingPreviewFiles.size > 0) {
      const previewUrl = ctx.previewServiceUrl || PREVIEW_SERVICE_URL;
      const files = Array.from(ctx.pendingPreviewFiles.entries()).map(([path, content]) => ({ path, content }));
      try {
        await fetch(`${previewUrl}/preview/${projectId}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files, fullSync: false }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // If flush fails, proceed anyway — stale errors are better than a crash
      }
    }

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    } catch (err: any) {
      return (
        `Preview service unreachable at ${PREVIEW_SERVICE_URL}: ${err.message}. ` +
        'The preview server may still be starting or is down. ' +
        'Do NOT keep calling get_build_errors — it will keep failing. ' +
        'Finish writing ALL your files first and stop. The system will handle the preview.'
      );
    }

    if (!res.ok) {
      if (res.status === 400) {
        return (
          'Preview service returned HTTP 400 — the project has not been pushed to the preview yet. ' +
          'This is NOT a code error. It means your files have NOT been sent to the build server yet. ' +
          'DO NOT keep calling get_build_errors — it will keep returning 400 until the files are pushed. ' +
          'INSTEAD: Finish writing ALL your files first, then stop. The system will push files automatically after you finish. ' +
          'If this is a repair pass and files ARE on disk, the Vite dev server may still be starting — wait and retry ONCE.'
        );
      }
      if (res.status === 404) {
        return (
          'Preview service returned HTTP 404 — the project does not exist on the preview server. ' +
          'This means the project directory has not been created yet. ' +
          'Finish writing all your files. The system will create the project automatically.'
        );
      }
      if (res.status >= 500) {
        return (
          `Preview service returned HTTP ${res.status} — the server is experiencing an internal error. ` +
          'This is NOT a code error. Do NOT retry get_build_errors repeatedly. ' +
          'Finish your code changes and move on. The preview will recover on its own.'
        );
      }
      return (
        `Preview service returned HTTP ${res.status} for project ${args.projectId}. ` +
        'This is a service issue, not a code error. Do NOT retry get_build_errors for the same issue. ' +
        'Finish writing your files and stop.'
      );
    }

    let data: { healthy?: boolean; errors?: string[]; diagnosticKind?: string };
    try {
      data = await res.json() as { healthy?: boolean; errors?: string[]; diagnosticKind?: string };
    } catch {
      return 'Preview service returned invalid JSON';
    }

    if (data.healthy) {
      return 'No build errors — the preview is healthy and running correctly.';
    }

    const errors = data.errors ?? [];
    if (errors.length === 0) {
      return 'Preview is unhealthy but no error details are available yet. Try again in a moment.';
    }

    const diagnosticPrefix = data.diagnosticKind && data.diagnosticKind !== 'healthy'
      ? `${data.diagnosticKind} errors`
      : 'Build errors';

    // Deduplicate and trim stack traces — keep only the first meaningful line per error
    const seen = new Set<string>();
    const condensed: string[] = [];
    for (const e of errors) {
      // Extract just the first 2 lines (error type + location) — skip the stack trace
      const summary = e
        .split('\n')
        .slice(0, 6)
        .join('\n')
        .replace(/\/home\/[^/]+\/[^/]+\/[^/]+\/preview-service\/projects\//g, 'projects/')
        .trim();
      if (!seen.has(summary)) {
        seen.add(summary);
        condensed.push(summary);
      }
    }

    // Check if any "module not found" errors are for packages the agent declared
    // with <ecomgear-add-dependency> (legacy) — tell the agent to install them.
    const declaredDeps = ctx.getDeclaredDependencies?.() ?? [];
    const pendingDepNote: string[] = [];
    if (declaredDeps.length > 0) {
      const moduleNotFoundErrors = condensed.filter(e =>
        /module not found|cannot find module|cannot resolve|failed to resolve/i.test(e)
      );
      const matchingDeps = declaredDeps.filter(dep =>
        moduleNotFoundErrors.some(e => e.toLowerCase().includes(dep.toLowerCase()))
      );
      if (matchingDeps.length > 0) {
        pendingDepNote.push(
          `\n\nIMPORTANT: The following packages are declared via <ecomgear-add-dependency> but NOT yet installed: ${matchingDeps.join(', ')}. ` +
          `Use run_command({ command: "npm install ${matchingDeps.join(' ')}" }) to install them now. Do NOT remove imports or change code.`
        );
      }
    }

    // ─── Circuit breaker: if same errors appear 2+ times IN THE SAME RUN, tell agent to STOP ──
    // Entries older than MAX_ERROR_HISTORY_AGE_MS are treated as expired (new run).
    const now = Date.now();
    const errorSignature = condensed.map(e => e.slice(0, 80)).sort().join('|');
    const prev = errorHistory.get(projectId);
    const isExpired = prev && (now - prev.ts) > MAX_ERROR_HISTORY_AGE_MS;
    if (prev && !isExpired && prev.signature === errorSignature) {
      prev.count++;
      prev.ts = now;
      if (prev.count >= 2) {
        errorHistory.delete(projectId);
        return (
          `CIRCUIT BREAKER: These SAME ${condensed.length} errors appeared ${prev.count + 1} times in a row. ` +
          'Your fixes are NOT working. STOP calling get_build_errors. ' +
          'Instead: use write_file to REWRITE the broken file(s) completely from scratch — do not patch them. ' +
          'After rewriting, call get_build_errors ONE final time, then STOP regardless of result.\n\n' +
          `Errors: ${condensed.slice(0, 3).map((e, i) => `[${i + 1}] ${e}`).join('\n')}`
        );
      }
    } else {
      // New error signature, or entry expired (different run) — reset
      errorHistory.set(projectId, { signature: errorSignature, count: 1, ts: now });
    }

    return `${diagnosticPrefix} (${condensed.length} unique):\n\n${condensed.map((e, i) => `[${i + 1}] ${e}`).join('\n\n')}${pendingDepNote.join('')}`;
  },
};
