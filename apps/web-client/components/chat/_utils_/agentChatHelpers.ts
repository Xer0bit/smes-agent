import type { ChatAttachment } from '@/services/chatAttachmentService';
import type { AgentAttachment } from '@/eCG/UserPrompt/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolActivity {
  type: 'write' | 'edit' | 'delete' | 'rename' | 'dependency' | 'command';
  label: string;
}

/** One entry in the persistent step-by-step history shown alongside the live status line. */
export interface StepEntry {
  type: ToolActivity['type'] | 'status';
  label: string;
  done: boolean;
  /** Tool-call id while the call's input is still streaming; lets progress updates find their row. */
  id?: string;
  /** Characters of tool input generated so far (a file body, mostly). */
  chars?: number;
  /** Project path or function name the step targets, for matching the finished tool-output. */
  target?: string;
}

/** "write_file" + "src/pages/Home.tsx" -> a row label a person would write. */
export function describeToolCall(tool: string, target: string): { type: StepEntry['type']; label: string } {
  const t = target.replace(/^\/+/, '');
  switch (tool) {
    case 'write_file': return { type: 'write', label: `Writing ${t}` };
    case 'edit_file': return { type: 'edit', label: `Editing ${t}` };
    case 'delete_file': return { type: 'delete', label: `Removing ${t}` };
    case 'rename_file': return { type: 'rename', label: `Renaming ${t}` };
    case 'place_asset': return { type: 'write', label: `Placing ${t}` };
    case 'run_command': return { type: 'dependency', label: `Running ${t.slice(0, 60)}` };
    case 'write_edge_function': return { type: 'write', label: `Writing function ${t}` };
    case 'confirm_edge_function_deploy': return { type: 'write', label: `Deploying function ${t}` };
    case 'read_file': case 'read_files': return { type: 'status', label: `Reading ${t}` };
    case 'grep': case 'search_codebase': return { type: 'status', label: `Searching for ${t.slice(0, 50)}` };
    default: return { type: 'status', label: `${tool.replace(/_/g, ' ')} ${t}`.trim() };
  }
}

export function formatChars(n: number): string {
  if (n < 1024) return `${n} chars`;
  return `${(n / 1024).toFixed(1)} KB`;
}

/** A file being actively written/edited during streaming */
export interface LiveFileChange {
  path: string;
  type: 'write' | 'edit' | 'delete' | 'rename' | 'dependency';
  timestamp: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'pending' | 'streaming' | 'complete' | 'error';
  isPlan?: boolean;
  /** True when the agent replied without writing/deleting any files (ghostRun) and it wasn't a confirm-first ask */
  noChanges?: boolean;
  summary?: string;
  toolActivities?: ToolActivity[];
  /** Step-by-step history of the run (file ops + narrative steps)   not persisted, live-session only. */
  steps?: StepEntry[];
  attachments?: ChatAttachment[];
  /** Snapshot ID for rollback   present only on assistant messages after an agent run */
  snapshotId?: string;
  /** Commands the agent suggested (e.g. 'restart', 'refresh', 'rebuild') */
  suggestedCommands?: string[];
  /** AI-generated follow-up prompt chips shown after a build completes. null = loading */
  followUpSuggestions?: string[] | null;
  /** SQL this reply staged; shown as an ordered batch under it (AdminSqlCard). */
  stagedSql?: Array<{ id: string; sql_text: string; status: string; created_at: string; error_message?: string | null }>;
  batchId?: string | null;
}

// ─── Tag helpers ──────────────────────────────────────────────────────────────

// Extract and strip <SMEsAgent-chat-summary> from content
export function extractSummary(content: string): { body: string; summary?: string } {
  const match = content.match(/<SMEsAgent-chat-summary>([\s\S]*?)<\/SMEsAgent-chat-summary>/i);
  if (!match) return { body: content };
  return {
    body: content.replace(match[0], '').trim(),
    summary: match[1].trim(),
  };
}



// Parse all COMPLETED tool calls from raw agent output, deduplicating by path.
export function parseToolActivities(raw: string): ToolActivity[] {
  // Use a Map keyed by label so later operations for the same file overwrite earlier ones.
  const seen = new Map<string, ToolActivity>();

  for (const m of raw.matchAll(/<SMEsAgent-write[^>]*\bpath="([^"]+)"/gi))
    seen.set(m[1], { type: 'write', label: m[1] });

  for (const m of raw.matchAll(/<SMEsAgent-edit[^>]*\bpath="([^"]+)"/gi))
    seen.set(m[1], { type: 'edit', label: m[1] });

  for (const m of raw.matchAll(/<SMEsAgent-delete[^>]*\bpath="([^"]+)"/gi))
    seen.set(m[1], { type: 'delete', label: m[1] });

  for (const m of raw.matchAll(/<SMEsAgent-rename[^>]*\bfrom="([^"]+)"[^>]*\bto="([^"]+)"/gi)) {
    const label = `${m[1]} → ${m[2]}`;
    seen.set(label, { type: 'rename', label });
  }

  for (const m of raw.matchAll(/<SMEsAgent-add-dependency[^>]*\bpackages="([^"]+)"/gi))
    seen.set(`dep:${m[1]}`, { type: 'dependency', label: m[1] });

  for (const m of raw.matchAll(/<SMEsAgent-command[^>]*\btype="([^"]+)"/gi))
    seen.set(`cmd:${m[1]}`, { type: 'command', label: m[1] });

  return Array.from(seen.values());
}

/**
 * Build a readable summary from tool activities when the agent produced no
 * prose of its own. Reads like a short human sentence ("Updated the header,
 * sign-up, and about pages.") rather than a raw file-change log.
 */
export function buildFallbackSummary(activities: ToolActivity[]): string {
  const fileActs = activities.filter(a => ['write', 'edit', 'delete', 'rename'].includes(a.type));
  if (fileActs.length === 0) return '';

  const writes = fileActs.filter(a => a.type === 'write').length;
  const edits  = fileActs.filter(a => a.type === 'edit').length;
  const verb   = writes > 0 && edits === 0 ? 'Added' : 'Updated';

  const labels = Array.from(new Set(fileActs.map(a =>
    a.type === 'rename' ? a.label : filePathToLabel(a.label)
  )));

  const MAX = 4;
  const shown = labels.slice(0, MAX);
  const extra = labels.length - MAX;
  const list = extra > 0
    ? `${shown.join(', ')}, and ${extra} more`
    : shown.length > 1
      ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
      : shown[0];

  return `${verb} ${list}.`;
}

// Return a human-readable live status for the tool currently being streamed.
// Returns null when no tool is mid-flight.
export function detectLiveTool(raw: string): string | null {
  // An open <SMEsAgent-write> that hasn't been closed yet means we're streaming file content.
  const open = raw.match(/<SMEsAgent-write[^>]*\bpath="([^"]+)"[^>]*>(?![\s\S]*?<\/SMEsAgent-write>)/i);
  if (open) return `Writing ${open[1]}…`;

  // Partial tag (agent is still typing the opening tag itself)
  if (/<SMEsAgent-/i.test(raw.replace(/<SMEsAgent-[\s\S]*?<\/SMEsAgent-\w+>/gi, '')
                              .replace(/<SMEsAgent-(?:rename|delete|add-dependency|command|file)[^>]*>/gi, ''))) {
    return 'Working…';
  }
  return null;
}

// Extract command types the agent suggested (e.g. restart, refresh, rebuild)
// Handles both <SMEsAgent-command> and abbreviated <egear-command> variants.
export function parseCommandSuggestions(raw: string): string[] {
  const cmds: string[] = [];
  for (const m of raw.matchAll(/<(?:SMEsAgent|egear)-command[^>]*\btype="([^"]+)"/gi))
    if (!cmds.includes(m[1])) cmds.push(m[1]);
  return cmds;
}


// Strip ALL <SMEsAgent-*> / <egear-*> tags from the visible chat text.
// During streaming, any open (unclosed) block tag hides everything after it
// so the user never sees raw XML or partial code.
export function stripSMEsAgentTags(raw: string): string {
  let s = raw;

  // Strip model-internal reasoning/tool-call markup (thinking blocks, function calls)
  // that leaks from DeepSeek, Gemini, and plan-mode responses into the text stream.
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  s = s.replace(/<thinking>[\s\S]*?<\/antml:thinking>/gi, '');
  s = s.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');
  s = s.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, '');
  s = s.replace(/<invoke[\s\S]*?<\/invoke>/gi, '');
  // Partial/unclosed internal block still streaming   truncate at start of tag
  const internalPartials: RegExp[] = [/<(?:antml:)?thinking>/i, /<function_calls[\s>]/i, /<tool_calls[\s>]/i, /<invoke[\s>]/i];
  for (const re of internalPartials) {
    const idx = s.search(re);
    if (idx !== -1) { s = s.slice(0, idx); break; }
  }

  // Remove complete SMEsAgent/egear block tags + their content
  s = s.replace(/<SMEsAgent-write[\s\S]*?<\/SMEsAgent-write>/gi, '\n\n');
  s = s.replace(/<SMEsAgent-edit[\s\S]*?<\/SMEsAgent-edit>/gi, '\n\n');
  s = s.replace(/<SMEsAgent-chat-summary>[\s\S]*?<\/SMEsAgent-chat-summary>/gi, '');

  // Remove complete self-closing / void tags (both SMEsAgent- and egear- prefixes)
  s = s.replace(/<(?:SMEsAgent|egear)-(rename|delete|add-dependency|command|file)[^>]*\/?>/gi, '');

  // Remove any explicit closing tags (both prefix forms)
  s = s.replace(/<\/(?:SMEsAgent|egear)-[a-z-]+>/gi, '');

  // Hide everything from any still-open SMEsAgent/egear tag to end of buffer
  const partialIdx = s.search(/<(?:SMEsAgent|egear)-/i);
  if (partialIdx !== -1) s = s.slice(0, partialIdx);

  // Normalize whitespace
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

// ─── Human-friendly file path labels ────────────────────────────────────────
export function filePathToLabel(filePath: string): string {
  const base = filePath.replace(/\.[^.]+$/, '').split('/').pop() ?? filePath;
  const words = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
  if (words.startsWith('use ')) return words.replace('use ', '') + (words.endsWith(' hook') ? '' : ' hook');
  // Avoid doubling up when the filename already ends with the directory's
  // implied word (e.g. AboutPage.tsx in /pages/ → "about page", not "about page page").
  if (filePath.includes('/pages/')) return words.endsWith(' page') ? words : words + ' page';
  if (filePath.includes('/components/')) return words.endsWith(' component') ? words : words + ' component';
  if (filePath.includes('/hooks/')) return words.endsWith(' hook') ? words : words + ' hook';
  if (filePath.includes('/lib/') || filePath.includes('/utils/')) return words;
  if (base === 'App') return 'app shell';
  if (base === 'main') return 'app entry';
  return words;
}

// ─── Relevance scoring for older-turn compaction ────────────────────────────
// Same camelCase-aware tokenization idea as the KB layer's retrieval.ts
// (server-side, a separate deployable app -- can't share the module, so this
// is the client-side equivalent). Used to rank OLDER conversation turns by
// relevance to the CURRENT prompt when compacting them into olderSummary,
// instead of including them uniformly by chronological order regardless of
// whether they're actually relevant to what's being asked right now.

export function tokenize(text: string): string[] {
  const camelSplit = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return camelSplit.toLowerCase().split(/[\s/._\-(){}[\]:,;'"<>|]+/).filter(t => t.length > 2);
}

/** 0-1: fraction of `text`'s tokens that also appear in `referenceTokens`. */
export function relevanceScore(referenceTokens: Set<string>, text: string): number {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const t of tokens) if (referenceTokens.has(t)) hits++;
  return hits / tokens.length;
}

/**
 * Rebuild a composer-ready ChatAttachment from one handed over by another
 * surface (the dashboard's "New project" flow).
 *
 * AgentAttachment is the wire shape that survives the handoff; ChatAttachment
 * is what the composer renders. Two fields exist only on the latter:
 *
 *  - `previewUrl` falls back to `publicUrl`, NOT to an object URL. The object
 *    URL the original picker made belongs to the page that created it, and the
 *    handoff crosses a navigation (and possibly a sessionStorage round-trip,
 *    where it would serialise to a string pointing at nothing).
 *  - `size` is not carried across the handoff and is only used for the size
 *    label, so it comes back as 0 rather than being invented.
 *
 * `id` is derived from tempPath, which is already unique per upload, so a
 * double-seed cannot produce two chips with colliding React keys.
 */
export function seededChatAttachment(a: AgentAttachment): ChatAttachment {
  return {
    id: `seeded-${a.tempPath}`,
    name: a.name,
    size: 0,
    type: a.type,
    previewUrl: a.publicUrl ?? '',
    tempPath: a.tempPath,
    publicUrl: a.publicUrl ?? '',
    category: a.category,
  };
}

/**
 * Collapse a burst of calls into one per animation frame.
 *
 * The SSE stream delivers text in chunks of a few characters, and each one
 * used to run the tag-stripping regexes and a `setMessages` map, so the whole
 * message list re-rendered and every message re-parsed its markdown many
 * times per frame. Everything between two frames is invisible anyway, so
 * one flush per frame loses nothing the user could have seen.
 *
 * `cancel` exists for the terminal handlers: a flush left queued behind
 * `onDone` would overwrite the final message with the last streaming state.
 */
export function perFrame(flush: () => void): { schedule: () => void; cancel: () => void } {
  let frame = 0;
  return {
    schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; flush(); });
    },
    cancel() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
