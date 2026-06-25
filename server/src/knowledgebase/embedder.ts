/**
 * Embedding provider with automatic fallback chain:
 *   1. Google text-embedding-004  (768 dims, ~$0.025/MTok)
 *   2. OpenAI text-embedding-3-small (1536 dims, ~$0.020/MTok)
 *   3. BM25 pseudo-embedding (zero cost, in-memory, good enough for code files)
 *
 * Which provider is used depends on which API key is present in env.
 * Falls back gracefully — embedding failures never break the agent run.
 */

import { embedMany } from 'ai';

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
let _googleEmbedModel: string | null = null;

export function getProvider(): EmbeddingProvider {
  if (!_provider) _provider = detectProvider();
  return _provider;
}

/** Call after setting GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY at runtime. */
export function resetProviderCache(): void {
  _provider = null;
  _googleEmbedModel = null;
  _googleCircuitOpen = false;
  _openaiCircuitOpen = false;
}

// Circuit breaker — if an API embedding call fails, skip it for 30 minutes
// instead of retrying on every file write (wasted latency + log spam).
let _googleCircuitOpen = false;
let _openaiCircuitOpen = false;
let _googleCircuitResetAt = 0;
let _openaiCircuitResetAt = 0;
const CIRCUIT_TTL_MS = 30 * 60 * 1000;

function isGoogleCircuitOpen(): boolean {
  if (_googleCircuitOpen && Date.now() > _googleCircuitResetAt) {
    _googleCircuitOpen = false;
    _provider = null; // re-detect on reset
  }
  return _googleCircuitOpen;
}
function isOpenAICircuitOpen(): boolean {
  if (_openaiCircuitOpen && Date.now() > _openaiCircuitResetAt) {
    _openaiCircuitOpen = false;
    _provider = null;
  }
  return _openaiCircuitOpen;
}
function tripGoogleCircuit() {
  _googleCircuitOpen = true;
  _googleCircuitResetAt = Date.now() + CIRCUIT_TTL_MS;
  _provider = null;
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

// ─── Google (direct REST) ────────────────────────────────────────────────────
// Auto-discovers the best available embedding model for this API key.
// Preferred: text-embedding-004; falls back to whatever embedContent model exists.
const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com';
const PREFERRED_EMBED_MODELS = ['text-embedding-004', 'embedding-001', 'text-multilingual-embedding-002'];

async function discoverGoogleEmbedModel(apiKey: string): Promise<string> {
  try {
    const res = await fetch(
      `${GOOGLE_API_BASE}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (res.ok) {
      const data = await res.json() as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      const embedModels = (data.models ?? [])
        .filter(m => m.supportedGenerationMethods?.includes('embedContent'))
        .map(m => m.name.replace('models/', ''));
      // Pick in preference order
      for (const preferred of PREFERRED_EMBED_MODELS) {
        if (embedModels.includes(preferred)) return preferred;
      }
      if (embedModels.length > 0) return embedModels[0];
    }
  } catch { /* ignore — fall through to default */ }
  return 'text-embedding-004'; // best guess if discovery fails
}

async function getGoogleEmbedModel(apiKey: string): Promise<string> {
  if (!_googleEmbedModel) {
    _googleEmbedModel = await discoverGoogleEmbedModel(apiKey);
    console.info(`[kb/embedder] Google embedding model: ${_googleEmbedModel}`);
  }
  return _googleEmbedModel;
}

async function googleEmbedRequest(modelName: string, apiKey: string, texts: string[]): Promise<number[][]> {
  const baseUrl = `${GOOGLE_API_BASE}/v1beta/models/${modelName}`;

  if (texts.length === 1) {
    const res = await fetch(
      `${baseUrl}:embedContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${modelName}`,
          content: { parts: [{ text: texts[0] }] },
          outputDimensionality: EMBEDDING_DIMS_GOOGLE,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => String(res.status));
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as { embedding: { values: number[] } };
    return [data.embedding.values];
  }

  const res = await fetch(
    `${baseUrl}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${modelName}`,
          content: { parts: [{ text }] },
          outputDimensionality: EMBEDDING_DIMS_GOOGLE,
        })),
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => String(res.status));
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { embeddings: { values: number[] }[] };
  return data.embeddings.map((e: { values: number[] }) => e.values);
}

async function embedGoogle(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set');

  const model = await getGoogleEmbedModel(apiKey);
  try {
    return await googleEmbedRequest(model, apiKey, texts);
  } catch (err) {
    // If discovered model fails too (e.g. key has no embedding access), reset cache so next
    // probe can re-discover after a key change.
    _googleEmbedModel = null;
    throw err;
  }
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
      console.warn('[kb/embedder] Google embedding failed — circuit open 30 min, using BM25:', (err as Error)?.message?.slice(0, 200));
      tripGoogleCircuit();
    } else if (provider === 'openai') {
      console.warn('[kb/embedder] OpenAI embedding failed — circuit open 30 min, using BM25:', (err as Error)?.message?.slice(0, 200));
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
 * Probe the configured embedding provider at startup.
 * Trips the circuit now if it fails so no user request pays latency of a doomed call.
 */
export async function probeEmbeddingProvider(): Promise<void> {
  const provider = getProvider();
  if (provider === 'bm25') {
    console.info('[kb/embedder] Startup probe: no API key — using BM25 in-memory (KB count stays at 0)');
    return;
  }
  await embedTexts(['probe']);
  // Re-check after the call: if the circuit tripped, provider flipped to bm25
  const afterProvider = getProvider();
  if (afterProvider !== provider) {
    console.info(`[kb/embedder] Startup probe: ${provider} unavailable — using BM25`);
  } else {
    console.info(`[kb/embedder] Startup probe: ${provider} embeddings OK`);
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
