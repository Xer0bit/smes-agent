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
export const EMBEDDING_DIMS_BM25   = 768; // matches DB vector(768) column

export type EmbeddingProvider = 'google' | 'openai' | 'bm25';

function detectProvider(): EmbeddingProvider {
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY && !isGoogleCircuitOpen()) return 'google';
  if (process.env.OPENAI_API_KEY && !isOpenAICircuitOpen()) return 'openai';
  return 'bm25';
}

let _provider: EmbeddingProvider | null = null;
export function getProvider(): EmbeddingProvider {
  if (!_provider) _provider = detectProvider();
  return _provider;
}

/** Call after setting GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY at runtime. */
export function resetProviderCache(): void {
  _provider = null;
  _googleCircuitOpen = false;
  _openaiCircuitOpen = false;
}

// Circuit breaker — if an API embedding call fails, skip it for 5 minutes
// instead of retrying on every file write (wasted latency + log spam).
let _googleCircuitOpen = false;
let _openaiCircuitOpen = false;
let _googleCircuitResetAt = 0;
let _openaiCircuitResetAt = 0;
const CIRCUIT_TTL_MS = 5 * 60 * 1000;

function isGoogleCircuitOpen(): boolean {
  if (_googleCircuitOpen && Date.now() > _googleCircuitResetAt) _googleCircuitOpen = false;
  return _googleCircuitOpen;
}
function isOpenAICircuitOpen(): boolean {
  if (_openaiCircuitOpen && Date.now() > _openaiCircuitResetAt) _openaiCircuitOpen = false;
  return _openaiCircuitOpen;
}
function tripGoogleCircuit() {
  _googleCircuitOpen = true;
  _googleCircuitResetAt = Date.now() + CIRCUIT_TTL_MS;
  _provider = null; // re-detect on next call (may fall back to openai or bm25)
}
function tripOpenAICircuit() {
  _openaiCircuitOpen = true;
  _openaiCircuitResetAt = Date.now() + CIRCUIT_TTL_MS;
  _provider = null;
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
  // Try models in order — both produce 768-dim embeddings.
  // text-embedding-004 needs /v1; embedding-001 works on /v1beta (the SDK default).
  const candidates = [
    { baseURL: 'https://generativelanguage.googleapis.com/v1',      model: 'text-embedding-004' },
    { baseURL: 'https://generativelanguage.googleapis.com/v1beta',  model: 'embedding-001' },
  ];
  let lastErr: unknown;
  for (const { baseURL, model } of candidates) {
    try {
      const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY, baseURL });
      const m = google.textEmbeddingModel(model);
      const { embeddings } = await embedMany({ model: m, values: texts });
      return embeddings;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
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
    if (provider === 'google') {
      const result = await embedGoogle(texts);
      return result;
    }
    if (provider === 'openai') {
      const result = await embedOpenAI(texts);
      return result;
    }
  } catch (err) {
    if (provider === 'google') {
      console.warn('[kb/embedder] Google embedding failed — circuit open for 5 min, using BM25:', (err as Error)?.message?.slice(0, 120));
      tripGoogleCircuit();
    } else if (provider === 'openai') {
      console.warn('[kb/embedder] OpenAI embedding failed — circuit open for 5 min, using BM25:', (err as Error)?.message?.slice(0, 120));
      tripOpenAICircuit();
    }
  }
  return texts.map(bm25Embed);
}

export async function embedText(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  return v;
}

/**
 * Probe the configured embedding provider once (called from server startup).
 * If it fails immediately, the circuit trips now so no user request ever
 * pays the latency of a doomed API call.
 */
export async function probeEmbeddingProvider(): Promise<void> {
  const provider = getProvider();
  if (provider === 'bm25') return; // already on fallback
  try {
    await embedTexts(['probe']);
    console.info(`[kb/embedder] Startup probe: ${provider} embeddings OK`);
  } catch {
    // tripGoogleCircuit / tripOpenAICircuit already called inside embedTexts
    console.info(`[kb/embedder] Startup probe: ${provider} unavailable — using BM25`);
  }
}

/** Current circuit breaker / provider status for diagnostics. */
export function getEmbeddingStatus(): {
  provider: EmbeddingProvider;
  googleCircuitOpen: boolean;
  openaiCircuitOpen: boolean;
  googleCircuitResetsAt: number | null;
  openaiCircuitResetsAt: number | null;
} {
  return {
    provider: getProvider(),
    googleCircuitOpen: _googleCircuitOpen,
    openaiCircuitOpen: _openaiCircuitOpen,
    googleCircuitResetsAt: _googleCircuitOpen ? _googleCircuitResetAt : null,
    openaiCircuitResetsAt: _openaiCircuitOpen ? _openaiCircuitResetAt : null,
  };
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
