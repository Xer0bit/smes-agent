/**
 * Embedding provider with automatic fallback chain:
 *   1. Google text-embedding-004  (768 dims, ~$0.025/MTok)
 *   2. OpenAI text-embedding-3-small (1536 dims, ~$0.020/MTok)
 *   3. BM25 pseudo-embedding (zero cost, in-memory, good enough for code files)
 *
 * Which provider is used depends on which API key is present in env.
 * Falls back gracefully — embedding failures never break the agent run.
 */

import { embed, embedMany } from 'ai';

export const EMBEDDING_DIMS_GOOGLE = 768;
export const EMBEDDING_DIMS_OPENAI = 1536;
export const EMBEDDING_DIMS_BM25   = 256; // sparse hash projection

export type EmbeddingProvider = 'google' | 'openai' | 'bm25';

function detectProvider(): EmbeddingProvider {
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return 'google';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'bm25';
}

let _provider: EmbeddingProvider | null = null;
export function getProvider(): EmbeddingProvider {
  if (!_provider) _provider = detectProvider();
  return _provider;
}

export function getEmbeddingDims(): number {
  switch (getProvider()) {
    case 'google': return EMBEDDING_DIMS_GOOGLE;
    case 'openai': return EMBEDDING_DIMS_OPENAI;
    case 'bm25':   return EMBEDDING_DIMS_BM25;
  }
}

// ─── Google ─────────────────────────────────────────────────────────────────

async function embedGoogle(texts: string[]): Promise<number[][]> {
  const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
  const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
  const model = google.textEmbeddingModel('text-embedding-004');
  const { embeddings } = await embedMany({ model, values: texts });
  return embeddings;
}

// ─── OpenAI ─────────────────────────────────────────────────────────────────

async function embedOpenAI(texts: string[]): Promise<number[][]> {
  const { createOpenAI } = await import('@ai-sdk/openai');
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = openai.embedding('text-embedding-3-small');
  const { embeddings } = await embedMany({ model, values: texts });
  return embeddings;
}

// ─── BM25 pseudo-embedding ───────────────────────────────────────────────────
// Projects tokenized text onto a fixed-dim float vector via random hash projections.
// Preserves cosine similarity well enough for short code-file fingerprints.

function bm25Embed(text: string): number[] {
  const tokens = text.toLowerCase().split(/[\s/._\-(){}[\]:,;'"<>|]+/).filter(Boolean);
  const vec = new Float32Array(EMBEDDING_DIMS_BM25).fill(0);
  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const idx = h % EMBEDDING_DIMS_BM25;
    vec[idx] += 1 / (1 + Math.log(tokens.length + 1));
  }
  // L2 normalise
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec).map(v => v / norm);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const provider = getProvider();
  try {
    if (provider === 'google') return await embedGoogle(texts);
    if (provider === 'openai') return await embedOpenAI(texts);
  } catch (err) {
    console.warn('[kb/embedder] API embedding failed, falling back to BM25:', err);
  }
  return texts.map(bm25Embed);
}

export async function embedText(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  return v;
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
