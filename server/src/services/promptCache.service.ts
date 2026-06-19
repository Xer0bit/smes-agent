/**
 * Semantic prompt cache using pgvector + Gemini embeddings.
 *
 * Flow per request:
 *   1. Hash the prompt (exact match, free)
 *   2. If hash hit → return cached entry immediately
 *   3. Else embed with Gemini text-embedding-004 (~$0.000025/call)
 *   4. pgvector cosine similarity search (threshold 0.93)
 *   5. Cache miss → caller runs agent → store result
 *
 * Savings: cache hits cost ~$0 vs $0.04–$0.80 per agent run.
 */

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const GEMINI_EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent';
const SIMILARITY_THRESHOLD = 0.93;
const MAX_CACHE_PROMPT_CHARS = 2000;

export interface CacheEntry {
  id: string;
  project_id: string;
  prompt_text: string;
  tier: string;
  model_used: string;
  response_summary: string | null;
  files_written: Array<{ path: string; chars: number }>;
  tokens_used: number;
  hit_count: number;
}

function hashPrompt(projectId: string, prompt: string): string {
  return crypto.createHash('sha256').update(`${projectId}::${prompt.trim().toLowerCase()}`).digest('hex');
}

async function embedText(text: string): Promise<number[] | null> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY || '';
  if (!apiKey) return null;

  try {
    const res = await fetch(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/text-embedding-004',
        content: { parts: [{ text: text.slice(0, MAX_CACHE_PROMPT_CHARS) }] },
        taskType: 'SEMANTIC_SIMILARITY',
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { embedding?: { values: number[] } };
    return data.embedding?.values ?? null;
  } catch {
    return null;
  }
}

/** Look up a cached response. Returns entry if found, null if cache miss. */
export async function lookupCache(projectId: string, prompt: string, tier: string): Promise<CacheEntry | null> {
  if (!supabase) return null;
  // Only cache micro/fix — these are deterministic one-shot changes
  if (tier !== 'micro' && tier !== 'fix') return null;

  try {
    // 1. Exact hash match (free, instant)
    const hash = hashPrompt(projectId, prompt);
    const { data: exact } = await supabase
      .from('prompt_cache')
      .select('*')
      .eq('project_id', projectId)
      .eq('prompt_hash', hash)
      .single();

    if (exact) {
      await supabase.from('prompt_cache').update({ hit_count: exact.hit_count + 1, last_hit_at: new Date().toISOString() }).eq('id', exact.id);
      logger.info(`[PromptCache] Exact hit for project=${projectId} tier=${tier}`);
      return exact as CacheEntry;
    }

    // 2. Semantic similarity search
    const embedding = await embedText(prompt);
    if (!embedding) return null;

    const { data: similar } = await supabase.rpc('match_prompt_cache', {
      query_embedding: embedding,
      p_project_id: projectId,
      p_tier: tier,
      similarity_threshold: SIMILARITY_THRESHOLD,
      match_count: 1,
    });

    if (similar && similar.length > 0) {
      const entry = similar[0] as CacheEntry & { similarity: number };
      await supabase.from('prompt_cache').update({ hit_count: entry.hit_count + 1, last_hit_at: new Date().toISOString() }).eq('id', entry.id);
      logger.info(`[PromptCache] Semantic hit similarity=${entry.similarity?.toFixed(3)} project=${projectId} tier=${tier}`);
      return entry;
    }

    return null;
  } catch (err) {
    logger.warn('[PromptCache] Lookup error:', err);
    return null;
  }
}

/** Store a completed run in the cache. Call after a successful agent run. */
export async function storeCache(opts: {
  projectId: string;
  prompt: string;
  tier: string;
  modelUsed: string;
  responseSummary: string;
  filesWritten: Array<{ path: string; chars: number }>;
  tokensUsed: number;
}): Promise<void> {
  if (!supabase) return;
  if (opts.tier !== 'micro' && opts.tier !== 'fix') return;

  try {
    const hash = hashPrompt(opts.projectId, opts.prompt);
    const embedding = await embedText(opts.prompt);

    await supabase.from('prompt_cache').upsert({
      project_id: opts.projectId,
      prompt_hash: hash,
      prompt_text: opts.prompt.slice(0, MAX_CACHE_PROMPT_CHARS),
      embedding: embedding ? JSON.stringify(embedding) : null,
      tier: opts.tier,
      model_used: opts.modelUsed,
      response_summary: opts.responseSummary,
      files_written: opts.filesWritten,
      tokens_used: opts.tokensUsed,
      hit_count: 0,
    }, { onConflict: 'project_id,prompt_hash' });

    logger.info(`[PromptCache] Stored tier=${opts.tier} project=${opts.projectId} tokens=${opts.tokensUsed}`);
  } catch (err) {
    logger.warn('[PromptCache] Store error:', err);
  }
}
