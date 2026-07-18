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
const KEEP_RECENT_STEPS = 2;
/** Step number (0-indexed) at which compaction begins */
const COMPACT_AFTER_STEP = 3;

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
        args.content = `[compacted] ${lines} lines written to ${args.path ?? 'file'} — see Run Change Journal for details`;
      }
      break;
    case 'edit_file':
      if (typeof args.diff === 'string' && args.diff.length > 300) {
        const searchSnippet = args.diff.match(/<<<<<<< SEARCH\n([\s\S]{0,60})/)?.[1]?.replace(/\n/g, '↵') ?? '';
        args.diff = `[compacted] edit to ${args.path ?? 'file'} — target: "${searchSnippet}" — see Run Change Journal`;
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
 */
export function compactToolResult(part: any): void {
  const result = typeof part.result === 'string' ? part.result : JSON.stringify(part.result ?? '');
  switch (part.toolName) {
    case 'read_file':
      if (result.length > 300) {
        const lines = result.split('\n').length;
        part.result = `[compacted] ${lines}-line file read — agent saw full content at step time. Call read_file again if current content needed.`;
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

/**
 * Compact older step messages to reduce token count.
 * Keeps the original user/history messages + last KEEP_RECENT_STEPS steps
 * fully intact. Older steps have verbose tool args/results truncated.
 * Brain memories are injected as a user note before recent steps.
 */
export function compactStepMessages(
  messages: Array<any>,
  stepNumber: number,
  brainMemory: string[],
): Array<any> {
  // No compaction needed for early steps
  if (stepNumber < COMPACT_AFTER_STEP && brainMemory.length === 0) return messages;

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
    // No assistant messages yet — nothing to compact
    return messages;
  }

  // Each completed step adds 2 messages: assistant (tool calls) + tool (results)
  const stepMsgCount = msgs.length - stepStartIdx;
  const completedStepPairs = Math.floor(stepMsgCount / 2);
  const compactUpTo = Math.max(0, completedStepPairs - KEEP_RECENT_STEPS);

  if (stepNumber >= COMPACT_AFTER_STEP && compactUpTo > 0) {
    for (let pairIdx = 0; pairIdx < compactUpTo; pairIdx++) {
      const assistantIdx = stepStartIdx + pairIdx * 2;
      const toolIdx = assistantIdx + 1;

      // Compact assistant message (tool call args — file contents, diffs)
      const aMsg = msgs[assistantIdx];
      if (aMsg && Array.isArray(aMsg.content)) {
        for (const part of aMsg.content) {
          if (part.type === 'tool-call') compactToolCallArgs(part);
        }
        // Also compact any text parts (agent thinking/explanation between tool calls)
        for (const part of aMsg.content) {
          if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 400) {
            part.text = truncStr(part.text, 300);
          }
        }
      }

      // Compact tool message (results — file contents from read_file, grep, etc.)
      const tMsg = msgs[toolIdx];
      if (tMsg && Array.isArray(tMsg.content)) {
        for (const part of tMsg.content) {
          if (part.type === 'tool-result') compactToolResult(part);
        }
      }
    }

    const compactedTokensEst = Math.ceil(JSON.stringify(msgs).length / 3.5);
    console.log(`[Brain] Step ${stepNumber}: compacted ${compactUpTo} older steps, ~${compactedTokensEst} tokens est.`);
  }

  // Inject brain memories as context before recent steps
  if (brainMemory.length > 0) {
    const brainContent =
      '[Agent Brain — important facts you saved during this run. These persist across context compaction.]\n' +
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
 * Fast syntax-only TS/JSX check for a single file's content — NOT a full
 * type-checked `tsc --noEmit` project build (that needs a persistent
 * ts.LanguageService per project; out of scope here). This only catches
 * structural breakage (unclosed brackets, malformed JSX, stray tokens) —
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
