/**
 * Status service — the SINGLE source of "what is the agent doing right now".
 *
 * Replaces the old trio of overlapping systems:
 *   - deriveStepStatus()          (rule-based canned strings)
 *   - generateDynamicStepStatus() (thin post-step LLM status)
 *   - ad-hoc hardcoded strings at lifecycle call sites
 *
 * Everything now flows through generateStatus(). It is:
 *   - LLM-DRIVEN: asks Gemini 2.5 Flash to write a short human line describing
 *     the current action, grounded in the agent's think() reasoning + intent.
 *   - REAL-TIME: called per tool-call stream part (before the tool runs) AND
 *     per lifecycle phase (sync, build check, router wiring, etc.).
 *   - NON-BLOCKING: 2.5s hard timeout, never throws. If the LLM is slow/down,
 *     a SPECIFIC honest fallback is used (never a generic "Working...").
 *   - DEDUPED: consecutive identical statuses within 1.5s are suppressed so the
 *     UI doesn't flicker, and the LLM isn't re-queried for the same action.
 *
 * State (latest think() reasoning + user intent) is kept per-project so the
 * narrator is always grounded in what the agent is actually trying to do.
 */

import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

// ─── Per-run state ───────────────────────────────────────────────────────────

interface RunState {
  /** Latest think() reasoning text — grounds every narration in real intent. */
  latestThought: string;
  /** The original user prompt for this run. */
  userPrompt: string;
  /** Last status text emitted, for dedup. */
  lastStatus: string;
  /** Timestamp of last status emit, for throttle. */
  lastStatusAt: number;
}

const states = new Map<string, RunState>();

export function beginRun(projectId: string, userPrompt: string): void {
  states.set(projectId, {
    latestThought: '',
    userPrompt: userPrompt.slice(0, 500),
    lastStatus: '',
    lastStatusAt: 0,
  });
}

export function updateThought(projectId: string, thought: string): void {
  const s = states.get(projectId);
  if (s) s.latestThought = String(thought).slice(0, 600);
}

export function endRun(projectId: string): void {
  states.delete(projectId);
}

// ─── Provider ────────────────────────────────────────────────────────────────

function getProvider() {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey && process.env.AI_DISABLE_GEMINI !== '1') {
    return createGoogleGenerativeAI({ apiKey: geminiKey })('gemini-2.5-flash');
  }
  const zaiKey = process.env.ZAI_API_KEY;
  if (zaiKey && process.env.AI_DISABLE_ZAI !== '1') {
    return createOpenAI({ apiKey: zaiKey, baseURL: 'https://api.z.ai/api/paas/v4' }).chat('glm-4.5-flash');
  }
  const anthropicKey = process.env.AI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && process.env.AI_DISABLE_ANTHROPIC !== '1') {
    return createAnthropic({ apiKey: anthropicKey })('claude-haiku-4-5-20251001');
  }
  return createGoogleGenerativeAI({ apiKey: geminiKey || 'missing' })('gemini-2.5-flash');
}

// ─── Core: generate a status line ────────────────────────────────────────────

export type StatusKind =
  | { kind: 'tool'; toolName: string; args: Record<string, unknown> }
  | { kind: 'lifecycle'; phase: LifecyclePhase; detail?: string };

export type LifecyclePhase =
  | 'start'
  | 'post-gen-verify'
  | 'router-wiring'
  | 'preview-sync'
  | 'build-check'
  | 'repair'
  | 'budget-reached'
  | 'rate-limit-retry'
  | 'provider-fallback'
  | 'done';

/**
 * Generate a short, human status describing what the agent is doing right now.
 * LLM-driven with honest, specific fallbacks. Never throws. Dedupes consecutive
 * identical statuses within 1.5s.
 *
 * @returns the status string, or null if it was deduped/suppressed.
 */
export async function generateStatus(projectId: string, what: StatusKind): Promise<string | null> {
  const state = states.get(projectId);

  // ── `think` content IS the narration already — no LLM round-trip ──────────
  if (what.kind === 'tool' && what.toolName === 'think') {
    const thought = typeof what.args.thought === 'string' ? what.args.thought : '';
    const first = humanize(thought);
    if (first) return emit(projectId, state, first);
    return null; // empty thought — don't overwrite the previous real status
  }

  // ── Build the prompt + fallback for everything else ────────────────────────
  const { prompt, fallback } = buildPromptAndFallback(what, state);

  let status: string | null = null;
  try {
    const result = await Promise.race([
      generateText({
        model: getProvider(),
        messages: [{
          role: 'user',
          content: prompt,
        }],
        maxOutputTokens: 25,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('status timeout')), 2500)),
    ]);
    status = cleanLlmText(result.text ?? '');
  } catch {
    status = null; // LLM unavailable — use fallback below
  }

  // Honest, SPECIFIC fallback (never a generic "Working..."). Built from the
  // actual tool/file/phase so it's always truthful even without the LLM.
  const finalStatus = status ?? fallback;
  if (!finalStatus) return null;
  return emit(projectId, state, finalStatus);
}

// ─── Prompt + fallback construction ──────────────────────────────────────────

function buildPromptAndFallback(
  what: StatusKind,
  state: RunState | undefined,
): { prompt: string; fallback: string } {
  const intent = state?.userPrompt ? state.userPrompt.slice(0, 150) : '';
  const thought = state?.latestThought ? state.latestThought.slice(0, 200) : '';

  if (what.kind === 'tool') {
    const { toolName, args } = what;
    const path = typeof args.path === 'string' ? args.path
      : typeof args.file_path === 'string' ? args.file_path : '';
    const fileLabel = path ? pathToLabel(path) : '';
    const cmd = typeof args.command === 'string' ? args.command : '';

    const verbMap: Record<string, string> = {
      write_file: 'creating',
      edit_file: 'updating',
      delete_file: 'removing',
      rename_file: 'renaming',
      read_file: 'reading',
      read_files: 'reading',
      list_files: 'scanning',
      grep: 'searching',
      get_build_errors: 'checking the build for',
      run_command: 'installing a package',
      get_database_schema: 'reading the database schema',
      query_database: 'running a database query',
      provision_database: 'setting up the database',
      write_edge_function: 'adding backend logic',
      place_asset: 'adding an image',
      search_org_knowledge: 'looking up project notes',
      save_memory: 'saving context',
      set_secret: 'saving a secret',
      list_secrets: 'checking saved secrets',
    };
    const verb = verbMap[toolName] ?? 'working on';
    const target = fileLabel || (cmd ? `a package (${cmd.split(/\s+/).slice(1, 3).join(' ')})` : '');

    const prompt =
      `A coding agent is building a web app for a user. The user asked: "${intent}".\n` +
      `The agent's internal plan was: "${thought}".\n` +
      `Right now the agent is ${verb}${target ? ` the ${target}` : ''}.\n\n` +
      `Describe what the agent is doing in under 8 words, present continuous tense, like a teammate ` +
      `narrating their own work in chat. Focus on the OUTCOME for the user (e.g. "Adding validation ` +
      `to the contact form"), not file names. No quotes, no trailing period, no emoji, no em dash.`;

    // Specific fallback built from the real operation
    let fallback = '';
    if (toolName === 'write_file' || toolName === 'edit_file') {
      fallback = fileLabel ? `${toolName === 'edit_file' ? 'Updating' : 'Building'} ${fileLabel}` : 'Writing code';
    } else if (toolName === 'delete_file') {
      fallback = fileLabel ? `Removing ${fileLabel}` : 'Removing a file';
    } else if (toolName === 'rename_file') {
      fallback = 'Renaming a file';
    } else if (toolName === 'read_file' || toolName === 'read_files') {
      fallback = fileLabel ? `Reading ${fileLabel}` : 'Reading the code';
    } else if (toolName === 'run_command' && cmd) {
      const pkg = cmd.split(/install|add/i)[1]?.trim().split(/\s+/)[0];
      fallback = pkg ? `Installing ${pkg}` : 'Installing a package';
    } else if (toolName === 'get_build_errors') {
      fallback = 'Checking the app compiles';
    } else if (toolName === 'list_files' || toolName === 'grep') {
      fallback = 'Looking through the project files';
    } else {
      fallback = `${cap(verb)}${target ? ` ${target}` : ''}`;
    }

    return { prompt, fallback };
  }

  // ── Lifecycle phases ──────────────────────────────────────────────────────
  const phaseText: Record<LifecyclePhase, { describe: string; fallback: string }> = {
    'start':               { describe: 'starting work on the request', fallback: 'Starting' },
    'post-gen-verify':     { describe: 'verifying the changes actually got applied to the files', fallback: 'Verifying the changes applied' },
    'router-wiring':       { describe: what.detail ? `connecting ${what.detail}` : 'connecting new pages to the app router', fallback: what.detail ? `Connecting ${what.detail}` : 'Connecting new pages to the app' },
    'preview-sync':        { describe: 'sending the updated files to the live preview', fallback: 'Sending files to the preview' },
    'build-check':         { describe: 'checking the app compiles and runs without errors', fallback: 'Checking the app compiles and runs' },
    'repair':              { describe: what.detail ? `auto-repairing build errors (${what.detail})` : 'auto-repairing build errors', fallback: what.detail ? `Repairing build errors (${what.detail})` : 'Repairing build errors' },
    'budget-reached':      { describe: 'finishing up after reaching the step limit', fallback: 'Finishing up' },
    'rate-limit-retry':    { describe: what.detail ? `the AI model is busy, retrying in ${what.detail}` : 'the AI model is busy, waiting to retry', fallback: what.detail ? `Model busy, retrying in ${what.detail}` : 'Model busy, retrying' },
    'provider-fallback':   { describe: 'switching to a backup AI model', fallback: 'Switching to a backup model' },
    'done':                { describe: 'finishing up', fallback: 'Finishing up' },
  };
  const cfg = phaseText[what.phase] ?? phaseText.done;

  const prompt =
    `A coding agent is building a web app. The user asked: "${intent}".\n` +
    `The agent's plan was: "${thought}".\n` +
    `Right now the agent is ${cfg.describe}.\n\n` +
    `Describe what is happening in under 8 words, present continuous tense, like a teammate ` +
    `narrating in chat. No quotes, no trailing period, no emoji, no em dash.`;

  return { prompt, fallback: cfg.fallback };
}

// ─── Emit (with dedup + throttle) ────────────────────────────────────────────

function emit(projectId: string, state: RunState | undefined, status: string): string | null {
  const now = Date.now();
  if (state) {
    // Dedup: identical status within 1.5s is suppressed (prevents flicker +
    // avoids re-querying the LLM for the same action).
    if (status === state.lastStatus && now - state.lastStatusAt < 1500) {
      return null;
    }
    state.lastStatus = status;
    state.lastStatusAt = now;
  }
  return status;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Take the first meaningful sentence of a think() thought, humanized. */
function humanize(thought: string): string | null {
  const first = thought
    .replace(/\n+/g, ' ')
    .replace(/^(okay|alright|so|now|first|let me|i will|i'll|i need to|i should|i'm going to)\s*/i, '')
    .trim()
    .split(/[.!?]/)[0]
    .trim();
  if (first.length <= 8) return null;
  return cap(first.length > 70 ? first.slice(0, 67) + '...' : first);
}

function cleanLlmText(text: string): string | null {
  const t = text.trim().replace(/^["']|["']$/g, '').replace(/\.$/, '').replace(/—/g, '-');
  if (!t || t.length < 3) return null;
  return t.length > 80 ? t.slice(0, 77) + '...' : t;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pathToLabel(p: string): string {
  const base = p.replace(/\.[^.]+$/, '').split('/').pop() ?? p;
  const words = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
  if (p.includes('/pages/')) return `${words} page`;
  if (p.includes('/components/')) return `${words} component`;
  return words;
}
