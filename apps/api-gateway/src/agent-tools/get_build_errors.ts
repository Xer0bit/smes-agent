/**
 * get_build_errors tool   query the Vite preview service for current build errors.
 *
 * This gives the agent the exact, real error messages from the live Vite dev server
 * instead of guessing from file contents. Call this FIRST when asked to fix an error.
 */
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { ToolDefinition, AgentContext } from './types.js';
import { getBlastRadius } from '../knowledgebase/symbolGraph.js';
import { computeErrorFingerprint, recordThrashTrip } from '../services/thrashDetector.js';

// ─── Circuit breaker: detect repeated identical error signatures per project ──
// Entries expire after MAX_ERROR_HISTORY_AGE_MS to avoid cross-run leakage.
const MAX_ERROR_HISTORY_AGE_MS = 10 * 60 * 1000; // 10 minutes

// Confirmed live 2026-08-04: `ecomgear-gen` runs as a 2-instance PM2 cluster
// on VPS3   a process-local Map means a retry landing on the OTHER worker
// silently resets the breaker, exactly when it matters most (the same
// error repeating is the signal this exists to catch). Backed by a shared
// Postgres table (build_error_breaker) when Supabase is configured; falls
// back to the previous in-memory Map only when it isn't (e.g. local dev
// without env vars set), so this degrades instead of hard-failing.
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const breakerDb = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const errorHistoryFallback = new Map<string, { signature: string; count: number; ts: number }>();

/** Returns whether this (projectId, signature) pair has now been seen 2+
 *  times in a row within MAX_ERROR_HISTORY_AGE_MS (and the hit count),
 *  resetting on trip (mirrors the previous Map.delete-on-trip behavior). */
async function checkCircuitBreaker(projectId: string, signature: string, now: number): Promise<{ tripped: boolean; count: number }> {
  if (!breakerDb) {
    const prev = errorHistoryFallback.get(projectId);
    const isExpired = prev !== undefined && (now - prev.ts) > MAX_ERROR_HISTORY_AGE_MS;
    if (prev && !isExpired && prev.signature === signature) {
      prev.count++;
      prev.ts = now;
      if (prev.count >= 2) { errorHistoryFallback.delete(projectId); return { tripped: true, count: prev.count }; }
      return { tripped: false, count: prev.count };
    }
    errorHistoryFallback.set(projectId, { signature, count: 1, ts: now });
    return { tripped: false, count: 1 };
  }

  const { data: row } = await breakerDb
    .from('build_error_breaker')
    .select('signature, hit_count, updated_at')
    .eq('project_id', projectId)
    .maybeSingle();
  const isExpired = row != null && (now - new Date(row.updated_at).getTime()) > MAX_ERROR_HISTORY_AGE_MS;

  if (row && !isExpired && row.signature === signature) {
    const newCount = row.hit_count + 1;
    if (newCount >= 2) {
      await breakerDb.from('build_error_breaker').delete().eq('project_id', projectId);
      return { tripped: true, count: newCount };
    }
    await breakerDb.from('build_error_breaker')
      .update({ hit_count: newCount, updated_at: new Date(now).toISOString() })
      .eq('project_id', projectId);
    return { tripped: false, count: newCount };
  }

  await breakerDb.from('build_error_breaker')
    .upsert({ project_id: projectId, signature, hit_count: 1, updated_at: new Date(now).toISOString() });
  return { tripped: false, count: 1 };
}

const PREVIEW_SERVICE_URL =
  process.env.PREVIEW_SERVICE_URL ||
  process.env.VITE_PREVIEW_SERVICE_URL ||
  'http://localhost:3001';

// Pulls the module specifier out of a "module not found" style error line
// (Vite/Rollup and Node phrase these differently, so match either quoting
// style rather than one exact format) and reduces it to the installable
// package root  a subpath import like "lodash/debounce" or
// "@radix-ui/react-dialog/Foo" still installs as "lodash" / "@radix-ui/react-dialog".
// Relative imports (./, ../) and the app's own "@/" path alias are not npm
// packages and must never be suggested for install.
export function extractMissingPackages(errorLines: string[]): string[] {
  const found = new Set<string>();
  for (const line of errorLines) {
    if (!/module not found|cannot find module|cannot resolve|failed to resolve/i.test(line)) continue;
    // Only the specifier immediately after "import"/"module"/"resolve" is
    // the missing package  a plain "any quoted string" match would also
    // catch the unrelated "from \"src/App.tsx\"" file-location clause.
    const matches = line.matchAll(/\b(?:import|module|resolve)\s+["']([^"']+)["']/gi);
    for (const m of matches) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')) continue;
      const parts = spec.split('/');
      const root = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (root) found.add(root);
    }
  }
  return Array.from(found);
}

const schema = z.object({
  projectId: z.string().describe('The project ID to check for build errors'),
});

export const getBuildErrorsTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'get_build_errors',
  description:
    'Query the live Vite preview server for current build errors. Returns exact error messages with file paths and line numbers. ' +
    'When to call: (1) FIRST at the start of a fix run   never guess at errors, ' +
    '(2) ONCE after ALL files are written in a batch   not after each individual file write. ' +
    '(3) When the user explicitly reports a broken state. ' +
    'LIMIT: Maximum 5 calls per run. After that, finish your response and stop.',
  inputSchema: schema,
  getConsentPreview: (args) => `Get build errors for project ${args.projectId}`,

  execute: async (args, ctx: AgentContext) => {
    const projectId = args.projectId || ctx.projectId;
    const previewUrl = ctx.previewServiceUrl || PREVIEW_SERVICE_URL;
    const checkUrl = `${previewUrl}/preview/${projectId}/check`;

    // ─── Per-run call cap: prevent infinite error-check loops ────────────────
    // Raised from 3 to 5 (2026-08 audit) alongside adding a real type-check
    // stage to the underlying /check endpoint (preview-service/lib/typecheck.js)
    // -- syntax errors and real type errors are now often found on separate
    // calls (the type-check only runs once syntax is already clean), so the
    // previous cap could cut off a legitimate fix-verify cycle before a type
    // error was ever surfaced. Still capped, not unlimited: a genuine
    // error-fix loop should still terminate, not retry indefinitely.
    ctx.buildErrorCallCount = (ctx.buildErrorCallCount ?? 0) + 1;
    const MAX_CALLS_PER_RUN = 5;
    if (ctx.buildErrorCallCount > MAX_CALLS_PER_RUN) {
      return (
        `STOP: get_build_errors has been called ${ctx.buildErrorCallCount} times this run (limit is ${MAX_CALLS_PER_RUN}). ` +
        'You are in an error-fix loop. Do NOT call get_build_errors again. ' +
        'End your response now. The preview will be updated automatically when your response finishes.'
      );
    }

    // Validate the run's pending edits (ctx.pendingPreviewFiles, accumulated by
    // write_file/edit_file across every step so far this run) against a DRY-RUN
    // check   never written to disk, never touches the live Vite instance the
    // user's browser is watching. Only the true end-of-run success push
    // (agentLoopService.ts) commits to the live, user-visible preview; this
    // check exists purely to give the agent real error feedback mid-run
    // without flickering the user's screen through half-finished states.
    const files = ctx.pendingPreviewFiles && ctx.pendingPreviewFiles.size > 0
      ? Array.from(ctx.pendingPreviewFiles.entries()).map(([path, content]) => ({ path, content }))
      : [];

    let res: Response;
    try {
      res = await fetch(checkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: unknown) {
      return (
        `Preview service unreachable at ${previewUrl}: ${err instanceof Error ? err.message : String(err)}. ` +
        'The preview server may still be starting or is down. ' +
        'Do NOT keep calling get_build_errors   it will keep failing. ' +
        'Finish writing ALL your files first and stop. The system will handle the preview.'
      );
    }

    if (!res.ok) {
      if (res.status >= 500) {
        return (
          `Preview service returned HTTP ${res.status}   the server is experiencing an internal error. ` +
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
      ctx.lastBuildErrorsHealthy = true;
      return 'No build errors   the preview is healthy and running correctly.';
    }

    const errors = data.errors ?? [];
    if (errors.length === 0) {
      // Inconclusive, not confirmed-broken   leave lastBuildErrorsHealthy as-is.
      return 'Preview is unhealthy but no error details are available yet. Try again in a moment.';
    }
    ctx.lastBuildErrorsHealthy = false;

    const diagnosticPrefix = data.diagnosticKind && data.diagnosticKind !== 'healthy'
      ? `${data.diagnosticKind} errors`
      : 'Build errors';

    // Deduplicate and trim stack traces   keep only the first meaningful line per error
    const seen = new Set<string>();
    const condensed: string[] = [];
    for (const e of errors) {
      // Extract just the first 2 lines (error type + location)   skip the stack trace
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

    // ─── Blast-radius note ────────────────────────────────────────────────────
    // Extract a likely component/symbol name from the error text (PascalCase
    // identifier is the strongest signal   React error messages name the
    // component, e.g. "Element type is invalid ... in Navbar"). Look it up in
    // the symbol graph and tell the agent what else calls/renders it, so it
    // doesn't fix the named file only to break every caller silently.
    let blastRadiusNote = '';
    try {
      const projectId = args.projectId || ctx.projectId;
      const candidateNames = new Set<string>();
      for (const e of condensed) {
        const matches = e.match(/\b[A-Z][A-Za-z0-9]{2,}\b/g) ?? [];
        for (const m of matches) candidateNames.add(m);
      }
      for (const name of [...candidateNames].slice(0, 3)) {
        const { callers } = await getBlastRadius(projectId, name);
        if (callers.length > 0) {
          const callerList = callers.slice(0, 5).map(c => `${c.symbol_name} (${c.file_path})`).join(', ');
          blastRadiusNote += `\n\n⚠️ BLAST RADIUS: "${name}" is used by: ${callerList}. If you change its props/signature, check these too.`;
        }
      }
    } catch { /* non-fatal   symbol graph is best-effort */ }

    // Check if any "module not found" errors are for packages the agent declared
    // with <ecomgear-add-dependency> (legacy)   tell the agent to install them.
    const declaredDeps = ctx.getDeclaredDependencies?.() ?? [];
    const moduleNotFoundErrors = condensed.filter(e =>
      /module not found|cannot find module|cannot resolve|failed to resolve/i.test(e)
    );
    const pendingDepNote: string[] = [];
    const matchingDeps = declaredDeps.filter(dep =>
      moduleNotFoundErrors.some(e => e.toLowerCase().includes(dep.toLowerCase()))
    );
    if (matchingDeps.length > 0) {
      pendingDepNote.push(
        `\n\nIMPORTANT: The following packages are declared via <ecomgear-add-dependency> but NOT yet installed: ${matchingDeps.join(', ')}. ` +
        `Use run_command({ command: "npm install ${matchingDeps.join(' ')}" }) to install them now. Do NOT remove imports or change code.`
      );
    }

    // A package the agent never declared via <ecomgear-add-dependency>
    // (e.g. it just wrote `import { z } from "zod"` assuming it's already
    // installed) used to dead-end here as a plain "module not found" error
    // with no next step. Any bare (non-relative, non-@/-alias) specifier
    // named in a module-not-found error is a genuine npm package by
    // definition   suggest installing it directly instead of leaving the
    // agent to rediscover `npm install` on its own.
    const undeclaredMissing = extractMissingPackages(moduleNotFoundErrors)
      .filter(pkg => !matchingDeps.some(dep => dep.toLowerCase() === pkg.toLowerCase()));
    if (undeclaredMissing.length > 0) {
      pendingDepNote.push(
        `\n\nIMPORTANT: These imported packages are not installed: ${undeclaredMissing.join(', ')}. ` +
        `Use run_command({ command: "npm install ${undeclaredMissing.join(' ')}" }) to install them now. Do NOT remove the imports or rewrite the code to avoid them.`
      );
    }

    // ─── Circuit breaker: if same errors appear 2+ times IN THE SAME RUN, tell agent to STOP ──
    // Entries older than MAX_ERROR_HISTORY_AGE_MS are treated as expired (new run).
    // Shared across PM2 cluster workers via checkCircuitBreaker   see its comment.
    const now = Date.now();
    const errorSignature = condensed.map(e => e.slice(0, 80)).sort().join('|');
    const breaker = await checkCircuitBreaker(projectId, errorSignature, now);
    if (breaker.tripped) {
      ctx.buildErrorCircuitBreakCount = (ctx.buildErrorCircuitBreakCount ?? 0) + 1;

      // ─── Session-level thrash detector ────────────────────────────────────
      // This in-call breaker resets its counter the moment it trips, so it has
      // no memory of whether the "rewrite from scratch" it just prescribed
      // actually worked. Record the trip against the persistent, file+kind
      // fingerprinted counter; a SECOND trip on the same underlying error
      // (even after a rewrite was already tried) escalates to an honest
      // stop-and-surface instead of a third confident rewrite attempt.
      const fingerprint = computeErrorFingerprint(condensed);
      const thrash = await recordThrashTrip(projectId, fingerprint);
      if (thrash.escalate) {
        ctx.thrashEscalated = true;
        ctx.thrashFingerprint = fingerprint;
        ctx.thrashTripCount = thrash.tripCount;
        return (
          `THRASH DETECTED: this exact error (${fingerprint}) has now tripped the circuit breaker ${thrash.tripCount} ` +
          `times   a previous rewrite-from-scratch attempt did NOT fix it. STOP trying to fix this yourself. ` +
          `Do not attempt another rewrite, do not state a new root cause, do not claim this is resolved. ` +
          `End your response now with an honest status: state plainly that you've made ${thrash.tripCount} attempts ` +
          `and the issue is still not resolved, briefly describe what you tried, and ask the user for guidance ` +
          `(e.g. more context, or permission to try a fundamentally different approach) instead of continuing.\n\n` +
          `Errors: ${condensed.slice(0, 3).map((e, i) => `[${i + 1}] ${e}`).join('\n')}`
        );
      }

      return (
        `CIRCUIT BREAKER: These SAME ${condensed.length} errors appeared ${breaker.count} times in a row. ` +
        'Your fixes are NOT working. STOP calling get_build_errors. ' +
        'Instead: use write_file to REWRITE the broken file(s) completely from scratch   do not patch them. ' +
        'After rewriting, call get_build_errors ONE final time, then STOP regardless of result.\n\n' +
        `Errors: ${condensed.slice(0, 3).map((e, i) => `[${i + 1}] ${e}`).join('\n')}`
      );
    }

    return `${diagnosticPrefix} (${condensed.length} unique):\n\n${condensed.map((e, i) => `[${i + 1}] ${e}`).join('\n\n')}${pendingDepNote.join('')}${blastRadiusNote}`;
  },
};
