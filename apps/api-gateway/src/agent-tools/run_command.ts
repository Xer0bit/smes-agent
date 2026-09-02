/**
 * run_command tool   execute safe, allowlisted shell commands in the project workspace.
 * Two kinds are permitted: dependency changes (npm install/uninstall) and
 * verification (npm test / npx vitest run / npx tsc --noEmit). See the
 * SECURITY note on buildVerifyEnv before widening either set.
 */
import { exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ToolDefinition, AgentContext } from './types.js';
import { VITEST_CONFIG_TS, VITEST_SETUP_TS } from '../services/baseTemplateService.js';

/**
 * Parse package names out of an npm install command.
 * e.g. "npm install chart.js lodash@4" → ["chart.js", "lodash@4"]
 */
function parsePackageNames(cmd: string): string[] {
  // Strip "npm install/i/add" prefix and any flags (starting with -)
  const withoutCmd = cmd.replace(/^npm\s+\S+/, '').trim();
  return withoutCmd
    .split(/\s+/)
    .filter(t => t && !t.startsWith('-'));
}

/**
 * Notify the preview service to install the same packages into its own
 * node_modules so Vite can resolve them. Fire-and-forget with a timeout  
 * a failure here is non-fatal; the local install already succeeded.
 */
/**
 * package.json is the dependency source of truth. After a local install, push
 * it to the preview service, which installs the project's extra packages into
 * a per-project layer (preview-service/lib/deps.js) and answers with the
 * result -- synchronously, so a failed install is a failed tool call, not a
 * silent divergence between the runner and the preview.
 */
async function syncPackageJsonToPreview(ctx: AgentContext): Promise<string> {
  const previewUrl = ctx.previewServiceUrl || 'http://localhost:3001';
  let content: string;
  try { content = readFileSync(path.join(ctx.appPath, 'package.json'), 'utf8'); } catch { return 'package.json not found; preview not updated.'; }
  const secret = process.env.PREVIEW_UPDATE_SECRET || '';
  try {
    const res = await Promise.race([
      fetch(`${previewUrl}/preview/${ctx.projectId}/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'x-update-secret': secret } : {}),
          ...(ctx.agentLockToken ? { 'x-agent-lock-token': ctx.agentLockToken } : {}),
        },
        body: JSON.stringify({ files: [{ path: 'package.json', content }], fullSync: false }),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('preview-service timeout after 200s')), 200_000)),
    ]);
    const body = (await res.json().catch(() => ({}))) as { deps?: { extras?: number; installed?: boolean; error?: string }; error?: string };
    if (!res.ok) return `Preview did not accept package.json (${res.status}${body.error ? `: ${body.error}` : ''}).`;
    const deps = body.deps;
    if (!deps) return 'Preview updated.';
    if (deps.error) return `PREVIEW INSTALL FAILED: ${deps.error}. The package is installed locally but the live preview cannot resolve it; fix the package name or version in package.json.`;
    return deps.installed ? `Preview installed ${deps.extras} project-specific package(s).` : 'Preview already had every dependency.';
  } catch (err) {
    return `Preview sync failed: ${err instanceof Error ? err.message : String(err)}. The live preview may not resolve the new package until the next push.`;
  }
}

const ALLOWED_PREFIXES = [
  'npm install ',
  'npm i ',
  'npm uninstall ',
  'npm remove ',
  'npm add ',
];

// ── Verification commands (gap G1, 2026-08-12) ───────────────────────────────
// Until now this tool ran npm install/uninstall and nothing else, which meant
// the agent had NO way to execute anything it wrote. Its entire notion of "did
// this work" was: does it compile (get_build_errors), and did #root get
// children (the post-run smoke check). It could never reproduce a reported
// bug, never run a test, never read real output. With no way to check, the
// model substitutes narration for evidence -- that is the root of the
// apology-loop / phantom-"fixed it" behaviour seen in production.
//
// Exact-match (not prefix) for the argument-less forms so `npm test` can never
// be smuggled into something else; prefix for the two that legitimately take
// file arguments.
const ALLOWED_VERIFY_EXACT = new Set(['npm test', 'npm run test', 'npx tsc --noemit']);
const ALLOWED_VERIFY_PREFIXES = ['npx vitest run', 'npx tsc --noemit'];

/**
 * SECURITY -- read before widening this tool further.
 *
 * Once the agent can run a test file it wrote, it can execute arbitrary code:
 * the allowlist below is NOT the security boundary and must never be mistaken
 * for one. It only prevents *accidental* damage (a stray `rm`, a curl) and
 * keeps output useful. The real boundary is this scrubbed environment.
 *
 * The parent process env carries every platform secret: Supabase service key,
 * all LLM provider keys, deploy secrets. Passing `...process.env` into a child
 * running agent-authored code would let a generated test read them and return
 * them straight back through this tool's own output, into the model's context
 * and then the user-visible chat. So verification commands get an explicit
 * allowlisted env instead -- only what a Node/npm toolchain actually needs.
 *
 * ponytail: KNOWN CEILING -- this closes secret exfiltration via env, and
 * nothing else. The child still runs as this process's uid with the whole
 * filesystem readable, so agent-authored code can still read another tenant's
 * project directory, and still reach the network. Closing those needs real
 * isolation (a container/user-namespace, or reusing preview-service's
 * child-process sandbox), which is gap G14, not this change. Do not widen
 * this tool's reach further until G14 lands.
 */
function buildVerifyEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'C.UTF-8',
    NODE_ENV: 'test',
    CI: 'true', // makes vitest/vite pick non-interactive, non-watch defaults
  };
}

/**
 * Test output is the whole point of this tool -- truncating it head-only would
 * throw away exactly the part the agent needs, since vitest prints its failure
 * summary last. Keep both ends when it overflows.
 */
function clampOutput(out: string, limit: number): string {
  if (out.length <= limit) return out;
  const head = Math.floor(limit * 0.3);
  const tail = limit - head;
  return `${out.slice(0, head)}\n\n...[${out.length - limit} chars trimmed]...\n\n${out.slice(-tail)}`;
}

const schema = z.object({
  command: z
    .string()
    .describe(
      'Command to run. Dependencies: "npm install recharts". Verification: "npm test" (runs the test suite), ' +
      '"npx vitest run src/foo.test.ts" (one file), "npx tsc --noEmit" (type-check only).'
    ),
});

export const runCommandTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'run_command',
  description:
    'Run a dependency or verification command inside the project directory.\n' +
    'Dependencies: "npm install recharts" / "npm uninstall lodash".\n' +
    'Verification: "npm test" runs the test suite; "npx vitest run <file>" runs one test file; ' +
    '"npx tsc --noEmit" type-checks without building.\n' +
    'Prefer running a test over asserting in chat that something works -- a passing test is ' +
    'evidence, a claim is not. If you fixed a bug, run the suite before saying it is fixed.\n' +
    'Nothing else is permitted (no arbitrary shell).',
  inputSchema: schema,
  modifiesState: true,

  execute: async (args, ctx: AgentContext) => {
    const cmd = args.command.trim();
    const lower = cmd.toLowerCase();

    const isPackageCmd = ALLOWED_PREFIXES.some((prefix) => lower.startsWith(prefix));
    const isVerifyCmd =
      ALLOWED_VERIFY_EXACT.has(lower) ||
      ALLOWED_VERIFY_PREFIXES.some((prefix) => lower.startsWith(`${prefix} `));

    if (!isPackageCmd && !isVerifyCmd) {
      return (
        `Error: "${cmd}" is not an allowed command.\n` +
        'Allowed: npm install/uninstall <pkg>, npm test, npx vitest run <file>, npx tsc --noEmit.'
      );
    }

    // Extra safety: block shell metacharacters
    if (/[;&|`$(){}[\]<>\\]/.test(cmd)) {
      return `Error: Command contains disallowed characters: "${cmd}"`;
    }

    // Verification commands need a runner that is actually installed. Only 4 of
    // 190 live projects have vitest today (every project created before the
    // base template was rebuilt 2026-08-01 predates it, and node_modules is
    // hard-linked at creation, so old projects never picked it up). Without
    // this preflight the agent gets a bare "vitest: not found" exit-127 and
    // has no idea it is fixable -- tell it exactly what to do instead.
    if (isVerifyCmd) {
      const wantsVitest = lower.startsWith('npx vitest') || lower === 'npm test' || lower === 'npm run test';
      if (wantsVitest && !existsSync(path.join(ctx.appPath, 'node_modules', '.bin', 'vitest'))) {
        return (
          'No test runner installed in this project. Install it first:\n' +
          '  run_command({ command: "npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom" })\n' +
          'then add a "test": "vitest run" script to package.json and re-run this command.'
        );
      }
      if (lower.startsWith('npx tsc') && !existsSync(path.join(ctx.appPath, 'node_modules', 'typescript'))) {
        return 'TypeScript is not installed in this project. Run: npm install -D typescript';
      }

      // Self-heal a missing vitest config. Measured live 2026-08-12: of 190
      // real projects, 4 had a test runner and only 1 had a config -- so the
      // default outcome of a React component test was "document is not
      // defined" (no jsdom environment), which reads as a code defect and is
      // not one. Deterministic single-file write, no npm, no network; cheaper
      // and far less derailing than making the agent discover this itself.
      if (wantsVitest) {
        const hasConfig = ['vitest.config.ts', 'vitest.config.js', 'vite.config.ts', 'vite.config.js']
          .some((f) => {
            const p = path.join(ctx.appPath, f);
            if (!existsSync(p)) return false;
            // A vite.config only counts if it actually configures `test`.
            if (f.startsWith('vitest.')) return true;
            try { return /\btest\s*:/.test(readFileSync(p, 'utf8')); } catch { return false; }
          });
        if (!hasConfig) {
          try {
            writeFileSync(path.join(ctx.appPath, 'vitest.config.ts'), VITEST_CONFIG_TS);
            const setupPath = path.join(ctx.appPath, 'src', 'test', 'setup.ts');
            if (!existsSync(setupPath)) {
              mkdirSync(path.dirname(setupPath), { recursive: true });
              writeFileSync(setupPath, VITEST_SETUP_TS);
            }
            console.log(`[run_command] Created missing vitest config for ${ctx.projectId}`);
          } catch (e) {
            console.warn(`[run_command] Could not write vitest config: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }

    // Harden install commands: disable postinstall hooks (arbitrary code execution),
    // skip audit (network call, slow), skip fund messages (noise in output).
    // Never add these flags to uninstall   they don't apply there.
    const isInstall = /^npm\s+(install|i|add)\b/.test(cmd);
    const safeCmd = isInstall
      ? cmd.replace(/^(npm\s+\S+)/, '$1 --ignore-scripts --no-audit --no-fund')
      : cmd;

    // Verification runs agent-authored code, so it gets the scrubbed env (see
    // buildVerifyEnv). Package commands keep the existing inherited env: npm
    // needs its own registry/proxy/cache config from there, and --ignore-scripts
    // above already stops any package code from executing during an install.
    const execEnv = isVerifyCmd
      ? buildVerifyEnv()
      : { ...process.env, NODE_ENV: 'development' };
    // A test suite legitimately takes longer than an install, but must still be
    // bounded -- an agent-written infinite loop would otherwise pin a worker.
    const timeoutMs = isVerifyCmd ? 180_000 : 120_000;
    const outputLimit = isVerifyCmd ? 4000 : 1500;

    const runCmd = (cmdToRun: string): Promise<{ ok: boolean; out: string; timedOut: boolean }> =>
      new Promise((resolve) => {
        exec(
          cmdToRun,
          { cwd: ctx.appPath, timeout: timeoutMs, env: execEnv, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const out = clampOutput([stdout, stderr].filter(Boolean).join('\n'), outputLimit);
            // exec sets err.killed with SIGTERM when it hits `timeout`.
            const timedOut = Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed);
            resolve({ ok: !err, out, timedOut });
          }
        );
      });

    let { ok, out, timedOut } = await runCmd(safeCmd);

    if (isVerifyCmd && timedOut) {
      return (
        `Command timed out after ${timeoutMs / 1000}s (${cmd}).\n` +
        'A test that never finishes is usually an unawaited promise, a watch-mode runner, or an ' +
        'infinite loop/render. Partial output:\n' + out
      );
    }

    // A verification command that fails is a SUCCESSFUL use of this tool -- the
    // agent asked a real question and got a real answer. Return the output as
    // findings, not as a tool error, so the loop treats it as signal to act on
    // rather than a malfunction to retry. (The identical-error circuit breaker
    // in agentLoopService keys on repeated identical failure strings; framing a
    // genuine test failure as "Command failed" would trip it on the second
    // identical run of a test the agent has not fixed yet.)
    if (isVerifyCmd) {
      // vitest exits 1 on "no test files found", which is NOT a failing test --
      // it is an empty suite. Every generated project starts with zero test
      // files, so this is the single most likely outcome of the agent's first
      // `npm test`. Reporting it as FAILED would send the agent hunting for a
      // defect that does not exist, which is precisely the wasted-loop
      // behaviour this tool was added to stop. Name it for what it is.
      if (!ok && /No test files found/i.test(out)) {
        return (
          `No tests exist yet (${cmd}) -- nothing was verified, and nothing is broken.\n` +
          'To actually verify this change, write a test first, e.g. src/<name>.test.ts:\n' +
          "  import { describe, it, expect } from 'vitest';\n" +
          "  it('does the thing', () => { expect(fn()).toBe(expected); });\n" +
          'then re-run. Do not claim the change is verified until a test actually passes.'
        );
      }
      return ok
        ? `PASSED (${cmd}):\n${out || '(no output)'}`
        : `FAILED (${cmd}) -- this is a real result, not a tool error. Fix the cause, then re-run:\n${out}`;
    }

    // Auto-retry with --legacy-peer-deps on peer dependency conflicts (ERESOLVE)
    if (!ok && isInstall && out.includes('ERESOLVE')) {
      const legacyCmd = safeCmd.replace(/^(npm\s+\S+)/, '$1 --legacy-peer-deps');
      const retry = await runCmd(legacyCmd);
      if (retry.ok) {
        ok = true;
        out = retry.out;
      } else {
        out = `Peer dep conflict. Tried --legacy-peer-deps too.\n${retry.out.slice(0, 800)}`;
      }
    }

    if (!ok) return `Command failed (${cmd}):\n${out}`;

    // Local install succeeded   sync packages to preview service + surface to UI
    let previewNote = '';
    if (isInstall) {
      const pkgs = parsePackageNames(cmd);
      previewNote = await syncPackageJsonToPreview(ctx);
      // Surface the install in the chat as an activity chip/steps entry.
      // The frontend already parses <ecomgear-add-dependency packages="…">
      // (agentChatHelpers.parseToolActivities)   previously dead because no tool
      // emitted it. Emits AFTER success so a failed install shows no chip.
      if (pkgs.length > 0) {
        ctx.onXmlComplete?.(`<ecomgear-add-dependency packages="${pkgs.join(', ')}" />`);
        // See AgentContext.nonFileMutation (agent-tools/types.ts): installing a
        // dependency is a real, consequential change with no project file to
        // track it by -- <ecomgear-add-dependency> feeds `dependencies`, not
        // `filesToWrite`. Without this, a turn whose only action was fixing a
        // blank screen by installing a missing package recorded
        // files_written=0 and was flagged ghostRun ("nothing changed") despite
        // having genuinely fixed the app. Measured 2026-08-16: 22 of 148
        // zero-file production runs were real mutations mislabelled this way,
        // including "Installed missing package to fix blank screen".
        ctx.nonFileMutation = true;
      }
    }

    return `Command succeeded (${cmd}):\n${out}${previewNote ? `\n${previewNote}` : ''}`;
  },
};
