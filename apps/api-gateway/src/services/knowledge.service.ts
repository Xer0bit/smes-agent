/**
 * Project knowledge: the chunks of context a run may carry into the prompt.
 *
 * Until 2026-09-02 "knowledge" was two free-text boxes on the project row
 * (custom_system_prompt, context_notes), injected verbatim into every run.
 * Everything else the agent knew (past chats, what changed, files the user
 * uploaded) was either rebuilt client-side per send or not kept at all, and
 * the owner had no way to see or prune any of it.
 *
 * Now every piece is a row in `project_knowledge` with a source, a heading,
 * its text and a token estimate. The owner sees the list, archives what a run
 * should not carry (kept, not sent), and deletes what should be gone. The
 * loop selects from the ACTIVE rows by relevance to the prompt under a fixed
 * budget, so more knowledge costs more eco only up to that ceiling.
 */
import { generateText } from 'ai';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { getCheapProvider } from './cheapModel.js';

export type KnowledgeSource = 'note' | 'agent' | 'chat' | 'change' | 'upload' | 'codebase';

export interface KnowledgeChunk {
  id: string;
  project_id: string;
  source: KnowledgeSource;
  /** Stable key within (project, source) so re-recording the same thing updates rather than duplicates. */
  source_ref: string | null;
  heading: string;
  content: string;
  tokens: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeEntry {
  source: KnowledgeSource;
  source_ref: string;
  heading: string;
  content: string;
}

/** Characters each chunk may keep; the rest is cut with a marker. */
export const MAX_CHUNK_CHARS = 4000;
/** Prompt budget for knowledge on one run, in characters (~2.5K tokens). */
export const KNOWLEDGE_PROMPT_BUDGET_CHARS = 10_000;

/** ~4 chars per token for English prose and code; cheap and close enough for a budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clip(text: string, max = MAX_CHUNK_CHARS): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n… (cut)` : t;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export async function listKnowledge(projectId: string): Promise<KnowledgeChunk[]> {
  const { data, error } = await supabase
    .from('project_knowledge')
    .select('id, project_id, source, source_ref, heading, content, tokens, archived, created_at, updated_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as KnowledgeChunk[];
}

export async function loadActiveKnowledge(projectId: string): Promise<KnowledgeChunk[]> {
  const { data, error } = await supabase
    .from('project_knowledge')
    .select('id, project_id, source, source_ref, heading, content, tokens, archived, created_at, updated_at')
    .eq('project_id', projectId)
    .eq('archived', false)
    .order('created_at', { ascending: false })
    .limit(400);
  if (error) throw new Error(error.message);
  return (data ?? []) as KnowledgeChunk[];
}

/**
 * Upsert a batch keyed by (project, source, source_ref). Best-effort: a
 * knowledge write must never fail a run, so errors are logged and swallowed.
 */
export async function recordKnowledge(projectId: string, entries: KnowledgeEntry[]): Promise<void> {
  const rows = entries
    .filter((e) => e.content.trim() && e.heading.trim())
    .map((e) => {
      const content = clip(e.content);
      return {
        project_id: projectId,
        source: e.source,
        source_ref: e.source_ref,
        heading: e.heading.trim().slice(0, 160),
        content,
        tokens: estimateTokens(content),
      };
    });
  if (rows.length === 0) return;
  const { error } = await supabase
    .from('project_knowledge')
    .upsert(rows, { onConflict: 'project_id,source,source_ref' });
  if (error) logger.warn('[knowledge] record failed', { projectId, count: rows.length, error: error.message });
}

// ─── Selection (pure) ─────────────────────────────────────────────────────────

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'you', 'can', 'all', 'add', 'make', 'use', 'have', 'into']);

export function knowledgeTokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Relevance of a chunk to the prompt: heading hits count triple. Owner notes
 * always score at least 1 and agent-saved facts at least 0.5, so neither is
 * crowded out by history that merely shares a word with the prompt.
 */
export function scoreChunk(chunk: Pick<KnowledgeChunk, 'source' | 'heading' | 'content'>, promptTerms: readonly string[]): number {
  const head = new Set(knowledgeTokens(chunk.heading));
  const body = new Set(knowledgeTokens(chunk.content));
  let hits = 0;
  for (const t of promptTerms) {
    if (head.has(t)) hits += 3;
    else if (body.has(t)) hits += 1;
  }
  // The codebase map is structure, useful for almost any request; it rides with agent facts.
  const base = chunk.source === 'note' ? 1 : chunk.source === 'agent' || chunk.source === 'codebase' ? 0.5 : 0;
  return base + (promptTerms.length ? hits / promptTerms.length : 0);
}

/**
 * Pick what goes into the prompt: every active note first (owner intent),
 * then the rest by relevance, newest first on ties, until the budget is
 * spent. A chunk that would overflow is skipped, not truncated, so one huge
 * upload cannot silently eat the whole budget.
 */
export function selectKnowledgeForPrompt(
  chunks: readonly KnowledgeChunk[],
  prompt: string,
  budgetChars = KNOWLEDGE_PROMPT_BUDGET_CHARS,
): KnowledgeChunk[] {
  const terms = knowledgeTokens(prompt);
  const active = chunks.filter((c) => !c.archived);
  const ranked = active
    .map((c) => ({ c, score: scoreChunk(c, terms) }))
    .sort((a, b) => {
      if (a.c.source === 'note' !== (b.c.source === 'note')) return a.c.source === 'note' ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return b.c.created_at.localeCompare(a.c.created_at);
    });

  const picked: KnowledgeChunk[] = [];
  let used = 0;
  for (const { c, score } of ranked) {
    // History with zero overlap is noise for this prompt. Notes and
    // agent-saved facts carry a base score, so this never drops them.
    if (score === 0) continue;
    const cost = c.heading.length + c.content.length + 8;
    if (used + cost > budgetChars) continue;
    picked.push(c);
    used += cost;
  }
  return picked;
}

const SOURCE_LABEL: Record<KnowledgeSource, string> = {
  note: 'Owner note',
  agent: 'Saved by the agent',
  chat: 'Earlier conversation',
  change: 'Earlier change',
  upload: 'Uploaded file',
  codebase: 'Codebase',
};

/** Prompt section. Headings carry the source so the model can weigh a note above history. */
export function renderKnowledge(chunks: readonly KnowledgeChunk[]): string {
  if (chunks.length === 0) return '';
  const blocks = chunks.map((c) => `### ${c.heading} (${SOURCE_LABEL[c.source]})\n${c.content}`);
  return `## Project knowledge\n\nWhat the owner has kept about this project. Notes are instructions; the rest is history.\n\n${blocks.join('\n\n')}`;
}

// ─── What a run leaves behind ─────────────────────────────────────────────────

/**
 * Uploaded documents are knowledge the owner handed over deliberately, so
 * their text is kept as-is. Conversations and change sets are NOT recorded
 * verbatim: that made a row per run, nearly all noise. What a run taught is
 * decided by the model, via save_knowledge during the run or the
 * distillation pass below after it.
 */
export function uploadsFromRun(run: {
  agentRunId: string;
  uploads: ReadonlyArray<{ name: string; text: string }>;
}): KnowledgeEntry[] {
  return run.uploads
    .filter((u) => u.text.trim())
    .map((u) => ({ source: 'upload' as const, source_ref: `${run.agentRunId}:${u.name}`, heading: u.name, content: u.text }));
}

export function knowledgeSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'fact';
}

const DISTILL_TIMEOUT_MS = 6000;
const MAX_DISTILLED_FACTS = 3;

/**
 * Parse the distillation model's answer: a JSON array of {heading, content}.
 * Tolerates prose around the array and drops anything malformed; a model that
 * returns `[]` or garbage records nothing, which is the correct default.
 */
export function parseDistilledFacts(raw: string): Array<{ heading: string; content: string }> {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const facts: Array<{ heading: string; content: string }> = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const heading = (item as { heading?: unknown }).heading;
    const content = (item as { content?: unknown }).content;
    if (typeof heading !== 'string' || typeof content !== 'string') continue;
    const h = heading.trim(); const c = content.trim();
    if (h.length < 3 || c.length < 10) continue;
    facts.push({ heading: h.slice(0, 120), content: c.slice(0, 1500) });
    if (facts.length >= MAX_DISTILLED_FACTS) break;
  }
  return facts;
}

/**
 * After a run, ask the cheap model whether anything durable was learned.
 * Fire-and-forget, bounded, never throws. Most runs yield nothing, and that
 * is the point: knowledge grows by facts, not by transcript.
 */
export async function distillRunKnowledge(run: {
  projectId: string;
  prompt: string;
  summary: string;
  touchedFiles: readonly string[];
  existingHeadings: readonly string[];
}): Promise<void> {
  if (!run.summary.trim() || run.prompt.trim() === '__rejoin__') return;
  try {
    const { model } = getCheapProvider();
    const already = run.existingHeadings.slice(0, 40).map((h) => `- ${h}`).join('\n') || '- (none)';
    const { text } = await Promise.race([
      generateText({
        model,
        maxOutputTokens: 400,
        temperature: 0,
        prompt:
          'You maintain a small memory for an AI app builder working on ONE project. Below is the latest exchange. ' +
          'Decide whether it contains anything a FUTURE run must remember that is not visible in the code itself: ' +
          'an owner decision or preference, a constraint, how an integration / auth / data model is shaped, a ' +
          'mistake to avoid. Ignore what was built (the code shows that), progress reports, and anything already ' +
          'in the existing headings. Reply with ONLY a JSON array of at most ' + MAX_DISTILLED_FACTS + ' objects ' +
          '{"heading": string, "content": string}; reply [] when there is nothing durable, which is the usual case.\n\n' +
          `Existing headings:\n${already}\n\n` +
          `Owner asked:\n${run.prompt.trim().slice(0, 2500)}\n\n` +
          `Agent replied:\n${run.summary.trim().slice(0, 2500)}\n\n` +
          `Files touched: ${run.touchedFiles.slice(0, 30).join(', ') || 'none'}`,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('distill timeout')), DISTILL_TIMEOUT_MS)),
    ]);
    const facts = parseDistilledFacts(text);
    if (facts.length === 0) return;
    await recordKnowledge(run.projectId, facts.map((f) => ({
      source: 'agent' as const,
      source_ref: `agent:${knowledgeSlug(f.heading)}`,
      heading: f.heading,
      content: f.content,
    })));
    logger.info('[knowledge] distilled', { projectId: run.projectId, facts: facts.map((f) => f.heading) });
  } catch (err) {
    logger.debug('[knowledge] distill skipped', { projectId: run.projectId, error: err instanceof Error ? err.message : String(err) });
  }
}
