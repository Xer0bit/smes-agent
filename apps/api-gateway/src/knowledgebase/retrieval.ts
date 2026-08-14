/**
 * Main retrieval API   combines vector search + graph expansion.
 *
 * Two public surfaces:
 *   indexFile()               called on every file write (background, non-blocking)
 *   retrieveRelevantFiles()   called before each agent run to select context files
 *
 * Graceful degradation:
 *   If Supabase/embedding is unavailable, falls back to recency-based selection
 *   (same behaviour as before this KB layer existed).
 */

import { embedText, embedTexts, cosineSim, getProvider } from './embedder.js';
import {
  upsertFileEmbedding,
  searchSimilarFiles,
  deleteFileEmbedding,
  isAlreadyIndexed,
} from './vectorStore.js';
import {
  parseImports,
  parseExports,
  upsertFileGraph,
  getDirectImports,
  getDirectDependents,
  deleteFileGraph,
} from './graphStore.js';
import { extractSymbols, upsertSymbolGraph, deleteSymbolGraph } from './symbolGraph.js';
import { getCachedRetrieval, setCachedRetrieval } from './retrievalCache.js';
import { rerankFiles } from './rerank.js';

export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface RetrievedFile {
  path: string;
  score: number;       // 0–1, higher = more relevant
  reason: 'vector' | 'graph-import' | 'graph-dependent' | 'recency' | 'mentioned';
}

// ─── Text to embed for a file ────────────────────────────────────────────────
// We embed path + first 600 chars of content. This keeps embedding tokens low
// (~200 tokens per file) while capturing component name + key symbols.

function buildEmbedInput(filePath: string, content: string): string {
  const preview = content.slice(0, 600).replace(/\s+/g, ' ').trim();
  return `${filePath}\n${preview}`;
}

// ─── Index a single file (called on write, background) ───────────────────────

export async function indexFile(
  projectId: string,
  filePath: string,
  content: string,
): Promise<void> {
  // Only index source files   skip binaries, lockfiles, generated output
  if (!isIndexableFile(filePath)) return;

  // Symbol graph is pure static analysis   no embedding provider required,
  // so it runs even on the bm25 (no-embedding) path below.
  try {
    upsertSymbolGraph(projectId, filePath, extractSymbols(content)).catch(() => {});
  } catch { /* non-fatal   regex extraction should never throw, but never risk indexFile on it */ }

  // BM25 is pure in-memory   storing its vectors in Supabase adds no value
  // (cosine sim on random-hash vectors is meaningless) and wastes 2 DB round-trips per file.
  if (getProvider() === 'bm25') return;

  try {
    // Skip if content hasn't changed
    if (await isAlreadyIndexed(projectId, filePath, content)) return;

    // Run embedding + graph parse in parallel
    const [embedding] = await Promise.all([
      embedText(buildEmbedInput(filePath, content)),
      upsertFileGraph(
        projectId,
        filePath,
        parseImports(filePath, content),
        parseExports(content),
      ),
    ]);

    await upsertFileEmbedding(projectId, filePath, content, embedding);
  } catch (err) {
    // Non-fatal   agent still runs without KB
    console.warn('[kb/retrieval] indexFile failed for', filePath, err);
  }
}

/**
 * Index multiple files (batch, e.g. on project load or a multi-file write).
 * Unlike calling indexFile() per file -- which fires one embedText() network
 * round-trip EACH -- this embeds every changed file in a single embedTexts()
 * batch call. embedTexts() already existed for exactly this; indexFiles()
 * just never used it, so a 10-file feature-tier write paid for 10 separate
 * embedding API calls instead of 1.
 */
export async function indexFiles(
  projectId: string,
  files: WorkspaceFile[],
): Promise<void> {
  const indexable = files.filter(f => isIndexableFile(f.path));
  if (indexable.length === 0) return;

  // Symbol graph is pure static analysis, independent of the embedding
  // provider -- same as indexFile()'s handling, run for every indexable file.
  await Promise.allSettled(
    indexable.map(async f => {
      try {
        await upsertSymbolGraph(projectId, f.path, extractSymbols(f.content));
      } catch { /* regex extraction should never throw, but never risk the batch on it */ }
    }),
  );

  if (getProvider() === 'bm25') return; // no real embeddings to batch

  // Skip files whose content hasn't changed, same content-hash check indexFile() does.
  const toEmbed: WorkspaceFile[] = [];
  await Promise.allSettled(
    indexable.map(async f => {
      try {
        if (!(await isAlreadyIndexed(projectId, f.path, f.content))) toEmbed.push(f);
      } catch {
        toEmbed.push(f); // can't confirm it's cached -- index it rather than skip it
      }
    }),
  );
  if (toEmbed.length === 0) return;

  // The actual batch: one embedTexts() call for every changed file.
  // embedTexts() never throws -- on provider failure it falls back to a
  // same-length BM25 pseudo-embedding array, so this always returns exactly
  // toEmbed.length vectors in order.
  const embeddings = await embedTexts(toEmbed.map(f => buildEmbedInput(f.path, f.content)));

  await Promise.allSettled(
    toEmbed.map(async (f, i) => {
      try {
        await Promise.all([
          upsertFileGraph(projectId, f.path, parseImports(f.path, f.content), parseExports(f.content)),
          upsertFileEmbedding(projectId, f.path, f.content, embeddings[i]),
        ]);
      } catch (err) {
        console.warn('[kb/retrieval] indexFiles: indexing failed for', f.path, err);
      }
    }),
  );
}

export async function removeFileIndex(
  projectId: string,
  filePath: string,
): Promise<void> {
  await Promise.allSettled([
    deleteFileEmbedding(projectId, filePath),
    deleteFileGraph(projectId, filePath),
    deleteSymbolGraph(projectId, filePath),
  ]);
}

// ─── Retrieve relevant files ─────────────────────────────────────────────────

export interface RetrievalOptions {
  maxFiles?: number;           // default 4
  graphExpansion?: boolean;    // include direct imports of top results (default true)
  mentionedPaths?: string[];   // files explicitly mentioned in prompt (always included)
  // LLM-graded re-rank of the merged candidate set before returning (see
  // rerank.ts). Opt-in and default false: the automatic per-run
  // initial-context pass is bounded to a 2s timeout and shouldn't absorb an
  // extra LLM round-trip -- only the on-demand search_codebase tool call
  // enables this, where the agent can afford a couple more seconds for a
  // meaningfully better-ordered result.
  rerank?: boolean;
}

/**
 * Returns a ranked list of file paths most relevant to the given prompt.
 * Falls back to recency order if the KB is unavailable.
 */
export async function retrieveRelevantFiles(
  projectId: string,
  prompt: string,
  allFiles: WorkspaceFile[],
  options: RetrievalOptions = {},
): Promise<RetrievedFile[]> {
  const {
    maxFiles = 4,
    graphExpansion = true,
    mentionedPaths = [],
    rerank = false,
  } = options;

  const existingPaths = new Set(allFiles.map(f => f.path));
  const results: RetrievedFile[] = [];
  const seen = new Set<string>();

  const add = (path: string, score: number, reason: RetrievedFile['reason']) => {
    if (!seen.has(path) && existingPaths.has(path)) {
      seen.add(path);
      results.push({ path, score, reason });
    }
  };

  // 1. Always include explicitly mentioned files first
  for (const p of mentionedPaths) add(p, 1.0, 'mentioned');

  const provider = getProvider();

  // BM25 is pure in-memory   skip the Supabase round-trip entirely and score directly.
  if (provider === 'bm25') {
    const bm25Results = scoreFilesLocally(prompt, allFiles, maxFiles);
    for (const r of bm25Results) if (r.score > 0) add(r.path, r.score, 'recency');
    if (results.filter(r => r.reason !== 'mentioned').length === 0) {
      const bySize = [...allFiles].sort((a, b) => b.content.length - a.content.length).slice(0, maxFiles);
      for (const f of bySize) add(f.path, 0.05, 'recency');
    }
    return results.sort((a, b) => b.score - a.score).slice(0, maxFiles + mentionedPaths.length);
  }

  // Cache only the DB-backed path -- BM25 above is pure in-memory and already
  // cheaper than a Redis round-trip would be.
  if (projectId) {
    const cached = await getCachedRetrieval(projectId, prompt, options);
    if (cached) return cached;
  }

  let vectorSimilar: { file_path: string; similarity: number }[] = [];
  try {
    // 2. Vector search via DB (google/openai embeddings only)
    const queryEmbedding = await embedText(prompt);
    vectorSimilar = await searchSimilarFiles(projectId, queryEmbedding, maxFiles + 4);
  } catch (err) {
    console.warn('[kb/retrieval] vector search failed, hybrid falls back to BM25-only:', err);
  }

  // 3. BM25 always runs alongside vector search now, not just as a fallback
  // after vector search comes back empty -- dense embeddings are weak on
  // exact-term queries (function names, error codes, IDs) even when a
  // vector match exists, so a fallback-only BM25 never got a chance to
  // contribute to those queries at all.
  const bm25Results = scoreFilesLocally(prompt, allFiles, maxFiles + 4);

  // 4. Reciprocal Rank Fusion: merge by RANK, not raw score. Cosine
  // similarity and BM25's weighted score live on different, incomparable
  // scales -- summing them directly would let whichever happens to run
  // numerically higher dominate. RRF needs no calibration between the two.
  const RRF_K = 60;
  const RRF_MAX = 2 / (1 + RRF_K); // theoretical max: rank #1 in both lists
  const rrfScores = new Map<string, number>();
  const strongVectorPaths = new Set<string>();
  vectorSimilar.forEach(({ file_path, similarity }, i) => {
    if (similarity <= 0.3) return; // keep the existing relevance floor
    rrfScores.set(file_path, (rrfScores.get(file_path) ?? 0) + 1 / (i + 1 + RRF_K));
    strongVectorPaths.add(file_path);
  });
  bm25Results.forEach((r, i) => {
    if (r.score <= 0) return;
    rrfScores.set(r.path, (rrfScores.get(r.path) ?? 0) + 1 / (i + 1 + RRF_K));
  });

  const mergedPaths = [...rrfScores.entries()].sort((a, b) => b[1] - a[1]);
  for (const [path, rawScore] of mergedPaths) {
    // Normalize back into the same 0-1 range the mentioned/graph-import/
    // graph-dependent buckets already use, so a strong hybrid hit still
    // outranks a fixed graph-expansion marker as intended.
    add(path, rawScore / RRF_MAX, strongVectorPaths.has(path) ? 'vector' : 'recency');
  }

  // 5. Graph expansion   seeded from the merged ranking now (not vector-only
  // as before), so an exact-term BM25 hit gets the same import/dependent
  // expansion a vector hit does. Same safety valve as before: only expand
  // from genuinely strong matches (vector > 0.3 or BM25 > 0.15) -- expanding
  // from a weak match (e.g. App.tsx matching "navbar" via an import line)
  // floods context with unrelated components like HeroSection, Footer, etc.
  const strongBm25Paths = new Set(bm25Results.filter(r => r.score > 0.15).map(r => r.path));
  const graphSeedPaths = mergedPaths
    .map(([path]) => path)
    .filter(path => strongVectorPaths.has(path) || strongBm25Paths.has(path));

  if (graphExpansion && graphSeedPaths.length > 0 && projectId) {
    try {
      const seeds = graphSeedPaths.slice(0, 3);
      const [imports, dependents] = await Promise.all([
        getDirectImports(projectId, seeds),
        getDirectDependents(projectId, seeds),
      ]);
      // Imports are more useful than dependents   include up to 2
      for (const p of resolveExtensions(imports, existingPaths).slice(0, 2)) {
        add(p, 0.7, 'graph-import');
      }
      // Dependents (files that use the found files)   include 1
      for (const p of dependents.slice(0, 1)) {
        add(p, 0.6, 'graph-dependent');
      }
    } catch { /* non-fatal */ }
  }

  // If both vector and BM25 scored everything at/below their floors (very
  // short prompt, or a prompt with no real overlap with the corpus), fall
  // back to largest files.
  if (results.filter(r => r.reason !== 'mentioned').length === 0) {
    const bySize = [...allFiles].sort((a, b) => b.content.length - a.content.length).slice(0, maxFiles);
    for (const f of bySize) add(f.path, 0.05, 'recency');
  }

  const sorted = results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles + mentionedPaths.length);

  // Explicitly mentioned files are already known-relevant (the user named
  // them) -- pin them ahead of reranking rather than asking the model to
  // re-judge something that was never a candidate in the first place.
  let final = sorted;
  if (rerank) {
    const mentionedEntries = sorted.filter(r => r.reason === 'mentioned');
    const rerankCandidates = sorted.filter(r => r.reason !== 'mentioned');
    const fileContents = new Map(allFiles.map(f => [f.path, f.content]));
    final = [...mentionedEntries, ...(await rerankFiles(prompt, rerankCandidates, fileContents))];
  }

  // Fire-and-forget: setCachedRetrieval never rejects (internal try/catch),
  // and the caller shouldn't wait on a cache write to get its results.
  if (projectId) void setCachedRetrieval(projectId, prompt, options, final);

  return final;
}

// ─── In-memory BM25 fallback (no DB required) ────────────────────────────────

/**
 * Pure in-memory relevance scoring   works without any DB or API.
 * Used when projectId is unknown or Supabase is not configured.
 */
export function scoreFilesLocally(
  prompt: string,
  files: WorkspaceFile[],
  limit = 4,
): RetrievedFile[] {
  const promptTokens = tokenize(prompt);
  if (promptTokens.length === 0) return files.slice(0, limit).map(f => ({ path: f.path, score: 0, reason: 'recency' as const }));

  const scores = files.map(f => {
    const pathTokens  = new Set(tokenize(f.path));
    const bodyTokens  = new Set(tokenize(f.content.slice(0, 800)));
    let weighted = 0;
    for (const t of promptTokens) {
      if (pathTokens.has(t))  weighted += 3; // path match is a strong signal (filename = component name)
      else if (bodyTokens.has(t)) weighted += 1; // body match is weaker (could be an import reference)
    }
    return {
      path: f.path,
      score: weighted / (promptTokens.length * 3 + 1), // normalise to 0-1
      reason: 'recency' as const,
    };
  });
  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const INDEXABLE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts',
  '.css', '.scss', '.html', '.json', '.md',
]);

const SKIP_PATTERNS = [
  /node_modules/,
  /\.min\.(js|css)$/,
  /dist\//,
  /\.d\.ts$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
];

function isIndexableFile(filePath: string): boolean {
  if (SKIP_PATTERNS.some(re => re.test(filePath))) return false;
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return INDEXABLE_EXTS.has(ext);
}

function tokenize(text: string): string[] {
  // Split camelCase/PascalCase before lowercasing so "HeroSection" → ["hero","section"],
  // "FactoryEngine" → ["factory","engine"], "FinalCTA" → ["final","cta"].
  const camelSplit = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return camelSplit.toLowerCase().split(/[\s/._\-(){}[\]:,;'"<>|]+/).filter(t => t.length > 2);
}

/** Try to match import paths (without extension) to actual workspace files. */
function resolveExtensions(importPaths: string[], existingPaths: Set<string>): string[] {
  const resolved: string[] = [];
  for (const p of importPaths) {
    if (existingPaths.has(p)) {
      resolved.push(p);
      continue;
    }
    // Try common extensions
    for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
      if (existingPaths.has(p + ext)) {
        resolved.push(p + ext);
        break;
      }
      if (existingPaths.has(`${p}/index${ext}`)) {
        resolved.push(`${p}/index${ext}`);
        break;
      }
    }
  }
  return resolved;
}
