import ts from 'typescript';

const MAX_PROMPT_CHARS = 8_000;
const MAX_OLDER_SUMMARY_CHARS = 6_000;
const MAX_FILE_TREE_CHARS = 5_000;   // trimmed: agent uses list_files for full tree
const MAX_ATTACHMENT_CONTEXT_CHARS = 24_000;

export { MAX_PROMPT_CHARS, MAX_OLDER_SUMMARY_CHARS, MAX_FILE_TREE_CHARS, MAX_ATTACHMENT_CONTEXT_CHARS };

export function clampContextSection(label: string, value: string, maxChars: number): string {
  if (!value || value.length <= maxChars) return value;
  const kept = value.slice(0, maxChars);
  const omitted = value.length - maxChars;
  return `${kept}\n\n[${label} truncated: omitted ${omitted} chars to keep prompt stable]`;
}

// ─── Server-side context window ("brain") ────────────────────────────────────
// Compacts older step messages to keep token count manageable across 25 steps.
// The agent can save important facts via save_memory tool; those survive compaction.

/** How many recent steps keep full detail (older steps get compacted) */
// Raised 2 → 4 (2026-07-20): a 2-step window compacted read_file results out
// of context mid-investigation on anything touching more than ~2-3 files  
// the model would then need to re-read a file it already saw 3 steps ago,
// producing a step that LOOKS like redundant re-analysis but is actually the
// model re-fetching evidence that was deleted out from under it. save_memory
// is the intended escape hatch but nothing enforces the model use it before
// compaction hits. Widening the window covers a realistic multi-file
// investigation before anything gets erased.
const KEEP_RECENT_STEPS = 4;
/** Step number (0-indexed) at which compaction begins */
const COMPACT_AFTER_STEP = 6;

export function truncStr(s: string | undefined, max: number): string {
  if (!s || s.length <= max) return s ?? '';
  const lines = s.split('\n').length;
  return s.substring(0, max) + `\n...[truncated, was ${lines} lines / ${s.length} chars]`;
}


export function compactToolCallArgs(part: any): void {
  const args = part.args;
  if (!args || typeof args !== 'object') return;
  switch (part.toolName) {
    case 'write_file':
      if (typeof args.content === 'string' && args.content.length > 200) {
        const lines = args.content.split('\n').length;
        args.content = `[compacted] ${lines} lines written to ${args.path ?? 'file'}   see Run Change Journal for details`;
      }
      break;
    case 'edit_file':
      if (typeof args.diff === 'string' && args.diff.length > 300) {
        const searchSnippet = args.diff.match(/<<<<<<< SEARCH\n([\s\S]{0,60})/)?.[1]?.replace(/\n/g, '↵') ?? '';
        args.diff = `[compacted] edit to ${args.path ?? 'file'}   target: "${searchSnippet}"   see Run Change Journal`;
      }
      break;
    case 'think':
      if (typeof args.thought === 'string' && args.thought.length > 500) {
        args.thought = truncStr(args.thought, 600);
      }
      break;
  }
}

/**
 * Shorten tool-result content in a tool message part.
 * Mutates `part.result` in-place.
 *
 * `supersededPath`: set when a LATER step in this same run touched the same
 * file again (read/write/edit). A superseded read is pure waste   the model
 * already has a fresher copy elsewhere in context   so it gets a terser stub
 * that points at the newer version instead of inviting a redundant re-read.
 */
export function compactToolResult(part: any, supersededPath?: string | null): void {
  const result = typeof part.result === 'string' ? part.result : JSON.stringify(part.result ?? '');
  switch (part.toolName) {
    case 'read_file':
      if (supersededPath) {
        part.result = `[content of ${supersededPath} superseded   see later version in this run]`;
      } else if (result.length > 300) {
        const lines = result.split('\n').length;
        part.result = `[compacted] ${lines}-line file read   agent saw full content at step time. Call read_file again if current content needed.`;
      }
      break;
    case 'grep':
      if (result.length > 300) part.result = truncStr(result, 200);
      break;
    case 'list_files':
      if (result.length > 400) part.result = truncStr(result, 300);
      break;
    case 'get_build_errors':
      if (result.length > 500) part.result = truncStr(result, 400);
      break;
    // write_file, edit_file, delete_file, rename_file, think results are already short
  }
}

const FILE_TOUCH_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);

/**
 * Maps file path -> last pairIdx (0-indexed, across the WHOLE run so far,
 * not just the compacted range) that touched it via read/write/edit. Used to
 * find reads that a later step already superseded, wherever "later" falls
 * still in the kept recent window counts, since a stale read is waste
 * regardless of which side of the compaction boundary the newer copy sits on.
 */
function buildFileTouchMap(msgs: any[], stepStartIdx: number, totalPairs: number): Map<string, number> {
  const lastTouch = new Map<string, number>();
  for (let pairIdx = 0; pairIdx < totalPairs; pairIdx++) {
    const aMsg = msgs[stepStartIdx + pairIdx * 2];
    if (!aMsg || !Array.isArray(aMsg.content)) continue;
    for (const part of aMsg.content) {
      if (part.type !== 'tool-call' || !FILE_TOUCH_TOOLS.has(part.toolName)) continue;
      const path = typeof part.args?.path === 'string' ? part.args.path : undefined;
      if (path) lastTouch.set(path, pairIdx);
    }
  }
  return lastTouch;
}

/**
 * Compact older step messages to reduce token count.
 * Keeps the original user/history messages + last KEEP_RECENT_STEPS steps
 * fully intact. Older steps have verbose tool args/results truncated.
 * Brain memories are injected as a user note before recent steps.
 */
// Early-write-stub threshold: write_file args at or above this size get their
// content stubbed as soon as the write is >=1 completed step old, WITHOUT
// waiting for the KEEP_RECENT_STEPS window. The content is on disk (the tool
// succeeded) and re-readable via read_file; re-sending it with every
// subsequent request is pure cost. Confirmed live 2026-08-09 (logo run,
// runId 929b1ec3): a 6k-token index.html written at step 10 rode along fully
// in steps 11-12's context, and step 11 happened to be a Gemini
// implicit-cache miss -- the echo was re-billed at full input price.
// Trade-off, deliberately accepted: stubbing an already-sent message breaks
// the byte-identical cache prefix ONCE at the step where the stub first
// applies, in exchange for permanently removing >=1k tokens from every
// subsequent step and shrinking the miss surface. The high threshold keeps
// small writes (the common case) from churning the prefix at all.
const EARLY_WRITE_STUB_MIN_CHARS = 4000;
const EARLY_WRITE_STUB_FROM_STEP = 3;

export function compactStepMessages(
  messages: Array<any>,
  stepNumber: number,
  brainMemory: string[],
): Array<any> {
  // No compaction needed for early steps
  if (stepNumber < Math.min(COMPACT_AFTER_STEP, EARLY_WRITE_STUB_FROM_STEP) && brainMemory.length === 0) return messages;

  // Deep clone to avoid mutating SDK internal state
  const msgs: Array<any> = structuredClone(messages);

  // Sanitize: tool-call args can be missing/undefined from the SDK itself.
  // Anthropic rejects tool_use.input that is not an object, so ensure args
  // is always at least {}.
  for (const msg of msgs) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool-call' && (part.args === undefined || part.args === null || typeof part.args !== 'object')) {
          part.args = {};
        }
      }
    }
  }

  // Find where step-generated messages begin (first assistant message after user/history)
  let stepStartIdx = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'assistant' && Array.isArray(msgs[i].content)) {
      stepStartIdx = i;
      break;
    }
  }
  if (stepStartIdx === 0 && msgs.length > 0 && msgs[0].role !== 'assistant') {
    // No assistant messages yet   nothing to compact
    return messages;
  }

  // Each completed step adds 2 messages: assistant (tool calls) + tool (results)
  const stepMsgCount = msgs.length - stepStartIdx;
  const completedStepPairs = Math.floor(stepMsgCount / 2);
  const compactUpToRaw = Math.max(0, completedStepPairs - KEEP_RECENT_STEPS);
  // Round down to the nearest KEEP_RECENT_STEPS batch instead of letting the
  // boundary advance by 1 every single step. Anthropic prompt caching needs
  // an exact byte-identical prefix; recomputing compactUpTo fresh from
  // completedStepPairs each call meant a DIFFERENT message crossed from full
  // to truncated on every step once compaction started, breaking the cache
  // prefix and forcing a full (expensive) cache rewrite every step for the
  // rest of the run instead of just once. Confirmed live: a 12-step run
  // showed cacheWrite on nearly every step post-compaction (not just step 1)
  // with input tokens climbing 28K->63K instead of flattening once cached --
  // a "small" task ended up costing $1.50+ because caching never stabilized.
  // Batching the boundary keeps the prefix byte-stable for KEEP_RECENT_STEPS-
  // step stretches, so cache reads actually accumulate between moves.
  const compactUpTo = Math.floor(compactUpToRaw / KEEP_RECENT_STEPS) * KEEP_RECENT_STEPS;

  if (stepNumber >= COMPACT_AFTER_STEP && compactUpTo > 0) {
    // Bounded to compactUpTo, NOT completedStepPairs: compactUpTo only moves
    // at KEEP_RECENT_STEPS batch boundaries (see comment above), so this map
    // is byte-stable for the same stretch of steps. Looking ahead into the
    // still-growing recent window would flip a read's superseded/not status
    // every single step as new steps complete, changing already-compacted
    // message content without compactUpTo itself moving   silently breaking
    // the exact cache-prefix stability this function was rewritten to fix.
    const fileTouchMap = buildFileTouchMap(msgs, stepStartIdx, compactUpTo);

    for (let pairIdx = 0; pairIdx < compactUpTo; pairIdx++) {
      const assistantIdx = stepStartIdx + pairIdx * 2;
      const toolIdx = assistantIdx + 1;

      // Compact assistant message (tool call args   file contents, diffs)
      const aMsg = msgs[assistantIdx];
      const pathByToolCallId = new Map<string, string>();
      if (aMsg && Array.isArray(aMsg.content)) {
        for (const part of aMsg.content) {
          if (part.type === 'tool-call') {
            if (part.toolName === 'read_file' && typeof part.args?.path === 'string' && part.toolCallId) {
              pathByToolCallId.set(part.toolCallId, part.args.path);
            }
            compactToolCallArgs(part);
          }
        }
        // Also compact any text parts (agent thinking/explanation between tool calls)
        for (const part of aMsg.content) {
          if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 400) {
            part.text = truncStr(part.text, 300);
          }
        }
      }

      // Compact tool message (results   file contents from read_file, grep, etc.)
      const tMsg = msgs[toolIdx];
      if (tMsg && Array.isArray(tMsg.content)) {
        for (const part of tMsg.content) {
          if (part.type !== 'tool-result') continue;
          const path = part.toolCallId ? pathByToolCallId.get(part.toolCallId) : undefined;
          const isSuperseded = Boolean(path && (fileTouchMap.get(path) ?? -1) > pairIdx);
          compactToolResult(part, isSuperseded ? path : null);
        }
      }
    }

    const compactedTokensEst = Math.ceil(JSON.stringify(msgs).length / 3.5);
    console.log(`[Brain] Step ${stepNumber}: compacted ${compactUpTo} older steps, ~${compactedTokensEst} tokens est.`);
  }

  // ── Early stub of LARGE write echoes inside the recent window ────────────
  // Applies to every completed step pair EXCEPT the most recent one (the
  // model keeps full sight of its immediately-preceding action). Deterministic
  // per step and idempotent (a stubbed arg is short, so it never re-matches
  // the size threshold), which keeps the message bytes stable across
  // subsequent prepareStep calls -- required for prompt-cache prefix reuse.
  if (stepNumber >= EARLY_WRITE_STUB_FROM_STEP) {
    let stubStartIdx = 0;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'assistant' && Array.isArray(msgs[i].content)) { stubStartIdx = i; break; }
    }
    if (stubStartIdx > 0 || (msgs.length > 0 && msgs[0].role === 'assistant')) {
      const pairCount = Math.floor((msgs.length - stubStartIdx) / 2);
      for (let pairIdx = 0; pairIdx < pairCount - 1; pairIdx++) {
        const aMsg = msgs[stubStartIdx + pairIdx * 2];
        if (!aMsg || aMsg.role !== 'assistant' || !Array.isArray(aMsg.content)) continue;
        for (const part of aMsg.content) {
          if (
            part.type === 'tool-call' &&
            part.toolName === 'write_file' &&
            typeof part.args?.content === 'string' &&
            part.args.content.length >= EARLY_WRITE_STUB_MIN_CHARS
          ) {
            const lines = part.args.content.split('\n').length;
            part.args.content = `[compacted early: large write] ${lines} lines written to ${part.args.path ?? 'file'} -- content is on disk, use read_file to view`;
          }
        }
      }
    }
  }

  // Inject brain memories as context before recent steps
  if (brainMemory.length > 0) {
    const brainContent =
      '[Agent Brain   important facts you saved during this run. These persist across context compaction.]\n' +
      brainMemory.map((m, i) => `${i + 1}. ${m}`).join('\n');
    const insertIdx = stepStartIdx + Math.max(0, compactUpTo * 2);
    msgs.splice(insertIdx, 0, {
      role: 'user' as const,
      content: brainContent,
    });
  }

  return msgs;
}

/**
 * Fast syntax-only TS/JSX check for a single file's content   NOT a full
 * type-checked `tsc --noEmit` project build (that needs a persistent
 * ts.LanguageService per project; out of scope here). This only catches
 * structural breakage (unclosed brackets, malformed JSX, stray tokens)  
 * exactly the failure mode that used to only surface in the cold, expensive
 * post-run repair pass. Runs in milliseconds since it's a single-file parse.
 * Returns a short diagnostic string, or null if the file parses clean.
 */
export function checkTsSyntaxInLoop(relPath: string, content: string): string | null {
  const normalizedPath = relPath.replace(/\\/g, '/');
  if (!/(^|\/)src\/.*\.(tsx|jsx)$/i.test(normalizedPath)) return null;
  try {
    const result = ts.transpileModule(content, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
      },
      reportDiagnostics: true,
      fileName: relPath,
    });
    if (result.diagnostics && result.diagnostics.length > 0) {
      const errors = result.diagnostics
        .slice(0, 3)
        .map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))
        .join('; ');
      return errors;
    }
    return null;
  } catch {
    return null; // never block the tool result on a transpiler crash
  }
}
