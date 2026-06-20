/**
 * Main retrieval API — combines vector search + graph expansion.
 *
 * Two public surfaces:
 *   indexFile()             — called on every file write (background, non-blocking)
 *   retrieveRelevantFiles() — called before each agent run to select context files
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
  // Only index source files — skip binaries, lockfiles, generated output
  if (!isIndexableFile(filePath)) return;

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
    // Non-fatal — agent still runs without KB
    console.warn('[kb/retrieval] indexFile failed for', filePath, err);
  }
}

/** Index multiple files in parallel (batch, e.g. on project load). */
export async function indexFiles(
  projectId: string,
  files: WorkspaceFile[],
): Promise<void> {
  const indexable = files.filter(f => isIndexableFile(f.path));
  await Promise.allSettled(
    indexable.map(f => indexFile(projectId, f.path, f.content)),
  );
}

export async function removeFileIndex(
  projectId: string,
  filePath: string,
): Promise<void> {
  await Promise.allSettled([
    deleteFileEmbedding(projectId, filePath),
    deleteFileGraph(projectId, filePath),
  ]);
}

// ─── Retrieve relevant files ─────────────────────────────────────────────────

export interface RetrievalOptions {
  maxFiles?: number;           // default 4
  graphExpansion?: boolean;    // include direct imports of top results (default true)
  mentionedPaths?: string[];   // files explicitly mentioned in prompt (always included)
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

  // If BM25 is active (no Google/OpenAI key), skip the DB vector search entirely —
  // BM25 produces 256-dim vectors which are blocked by the 768-dim DB column.
  // Use in-memory scoring directly instead of wasting a round-trip that returns [].
  const provider = getProvider();
  const hasRealEmbeddings = provider !== 'bm25';

  if (hasRealEmbeddings) {
    try {
      // 2. Vector search (only when real embeddings are available)
      const queryEmbedding = await embedText(prompt);
      const similar = await searchSimilarFiles(projectId, queryEmbedding, maxFiles + 2);

      const vectorPaths: string[] = [];
      for (const { file_path, similarity } of similar) {
        if (similarity > 0.3) {
          add(file_path, similarity, 'vector');
          vectorPaths.push(file_path);
        }
      }

      // 3. Graph expansion — add direct imports of vector-found files
      if (graphExpansion && vectorPaths.length > 0) {
        const [imports, dependents] = await Promise.all([
          getDirectImports(projectId, vectorPaths),
          getDirectDependents(projectId, vectorPaths),
        ]);

        // Imports are more useful than dependents — include up to 2
        for (const p of resolveExtensions(imports, existingPaths).slice(0, 2)) {
          add(p, 0.7, 'graph-import');
        }
        // Dependents (files that use the found files) — include 1
        for (const p of dependents.slice(0, 1)) {
          add(p, 0.6, 'graph-dependent');
        }
      }
    } catch (err) {
      console.warn('[kb/retrieval] vector/graph retrieval failed, falling back to BM25:', err);
    }
  }

  // 4. BM25 in-memory scoring — used when no real embedding provider is configured,
  // or when vector search returned no results above the similarity threshold.
  if (results.filter(r => r.reason !== 'mentioned').length === 0) {
    const bm25Results = scoreFilesLocally(prompt, allFiles, maxFiles);
    const bm25Paths: string[] = [];
    for (const r of bm25Results) {
      if (r.score > 0) {
        add(r.path, r.score, 'recency');
        bm25Paths.push(r.path);
      }
    }

    // Expand graph only from files with a meaningful BM25 score (> 0.15).
    // Expanding from weakly-matched files (e.g. App.tsx matched "navbar" via an import line)
    // floods context with unrelated components like HeroSection, Footer, etc.
    const strongBm25 = bm25Results.filter(r => r.score > 0.15).map(r => r.path);
    if (graphExpansion && strongBm25.length > 0 && projectId) {
      try {
        const [imports, dependents] = await Promise.all([
          getDirectImports(projectId, strongBm25.slice(0, 2)),
          getDirectDependents(projectId, strongBm25.slice(0, 2)),
        ]);
        for (const p of resolveExtensions(imports, existingPaths).slice(0, 2)) {
          add(p, 0.7, 'graph-import');
        }
        for (const p of dependents.slice(0, 1)) {
          add(p, 0.6, 'graph-dependent');
        }
      } catch { /* non-fatal */ }
    }

    // If BM25 also scored everything 0 (very short prompt), fall back to largest files
    if (results.filter(r => r.reason !== 'mentioned').length === 0) {
      const bySize = [...allFiles].sort((a, b) => b.content.length - a.content.length).slice(0, maxFiles);
      for (const f of bySize) add(f.path, 0.05, 'recency');
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles + mentionedPaths.length);
}

// ─── In-memory BM25 fallback (no DB required) ────────────────────────────────

/**
 * Pure in-memory relevance scoring — works without any DB or API.
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
