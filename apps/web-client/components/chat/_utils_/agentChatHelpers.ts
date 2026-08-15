import type { ChatAttachment } from '@/services/chatAttachmentService';

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
}

// ─── Tag helpers ──────────────────────────────────────────────────────────────

// Extract and strip <ecomgear-chat-summary> from content
export function extractSummary(content: string): { body: string; summary?: string } {
  const match = content.match(/<ecomgear-chat-summary>([\s\S]*?)<\/ecomgear-chat-summary>/i);
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

  for (const m of raw.matchAll(/<ecomgear-write[^>]*\bpath="([^"]+)"/gi))
    seen.set(m[1], { type: 'write', label: m[1] });

  for (const m of raw.matchAll(/<ecomgear-edit[^>]*\bpath="([^"]+)"/gi))
    seen.set(m[1], { type: 'edit', label: m[1] });

  for (const m of raw.matchAll(/<ecomgear-delete[^>]*\bpath="([^"]+)"/gi))
    seen.set(m[1], { type: 'delete', label: m[1] });

  for (const m of raw.matchAll(/<ecomgear-rename[^>]*\bfrom="([^"]+)"[^>]*\bto="([^"]+)"/gi)) {
    const label = `${m[1]} → ${m[2]}`;
    seen.set(label, { type: 'rename', label });
  }

  for (const m of raw.matchAll(/<ecomgear-add-dependency[^>]*\bpackages="([^"]+)"/gi))
    seen.set(`dep:${m[1]}`, { type: 'dependency', label: m[1] });

  for (const m of raw.matchAll(/<ecomgear-command[^>]*\btype="([^"]+)"/gi))
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
  // An open <ecomgear-write> that hasn't been closed yet means we're streaming file content.
  const open = raw.match(/<ecomgear-write[^>]*\bpath="([^"]+)"[^>]*>(?![\s\S]*?<\/ecomgear-write>)/i);
  if (open) return `Writing ${open[1]}…`;

  // Partial tag (agent is still typing the opening tag itself)
  if (/<ecomgear-/i.test(raw.replace(/<ecomgear-[\s\S]*?<\/ecomgear-\w+>/gi, '')
                              .replace(/<ecomgear-(?:rename|delete|add-dependency|command|file)[^>]*>/gi, ''))) {
    return 'Working…';
  }
  return null;
}

// Extract command types the agent suggested (e.g. restart, refresh, rebuild)
// Handles both <ecomgear-command> and abbreviated <egear-command> variants.
export function parseCommandSuggestions(raw: string): string[] {
  const cmds: string[] = [];
  for (const m of raw.matchAll(/<(?:ecomgear|egear)-command[^>]*\btype="([^"]+)"/gi))
    if (!cmds.includes(m[1])) cmds.push(m[1]);
  return cmds;
}


// Strip ALL <ecomgear-*> / <egear-*> tags from the visible chat text.
// During streaming, any open (unclosed) block tag hides everything after it
// so the user never sees raw XML or partial code.
export function stripEcomgearTags(raw: string): string {
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

  // Remove complete ecomgear/egear block tags + their content
  s = s.replace(/<ecomgear-write[\s\S]*?<\/ecomgear-write>/gi, '\n\n');
  s = s.replace(/<ecomgear-edit[\s\S]*?<\/ecomgear-edit>/gi, '\n\n');
  s = s.replace(/<ecomgear-chat-summary>[\s\S]*?<\/ecomgear-chat-summary>/gi, '');

  // Remove complete self-closing / void tags (both ecomgear- and egear- prefixes)
  s = s.replace(/<(?:ecomgear|egear)-(rename|delete|add-dependency|command|file)[^>]*\/?>/gi, '');

  // Remove any explicit closing tags (both prefix forms)
  s = s.replace(/<\/(?:ecomgear|egear)-[a-z-]+>/gi, '');

  // Hide everything from any still-open ecomgear/egear tag to end of buffer
  const partialIdx = s.search(/<(?:ecomgear|egear)-/i);
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
