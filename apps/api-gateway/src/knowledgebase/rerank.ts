/**
 * LLM-graded re-ranking of the RRF-merged candidate set -- the same thing a
 * cross-encoder buys over independent embedding-similarity scores (joint
 * query+candidate scoring instead of comparing two separately-computed
 * vectors), without adding a dedicated reranker API (Cohere Rerank, etc.) as
 * a new paid external dependency. Reuses the same fast/cheap provider chain
 * already configured for agent narration (narration.service.ts): Gemini
 * Flash, then z.ai GLM-4.5-Flash, then Claude Haiku.
 *
 * Bounded and best-effort by design, matching every other step in this
 * module: any timeout, provider failure, or malformed response degrades to
 * the untouched RRF order rather than blocking or throwing. Only used on the
 * on-demand search_codebase tool path (agent-initiated, no tight timeout) --
 * never on the automatic per-run initial-context pass, which is deliberately
 * bounded to 2s and already tolerates degrading to heuristic sort.
 */
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { RetrievedFile } from './retrieval.js';

const RERANK_TIMEOUT_MS = 2500;
// Below this, the RRF-merged order is already a small, trustworthy list --
// an LLM call adds latency without enough candidates for it to meaningfully
// re-sort.
const MIN_CANDIDATES_TO_RERANK = 5;

function getRerankModel(): { model: Parameters<typeof generateText>[0]['model']; label: string } | null {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey && process.env.AI_DISABLE_GEMINI !== '1') {
    return { model: createGoogleGenerativeAI({ apiKey: geminiKey })('gemini-flash-latest'), label: 'gemini-flash-latest' };
  }
  const zaiKey = process.env.ZAI_API_KEY;
  if (zaiKey) {
    return { model: createOpenAI({ apiKey: zaiKey, baseURL: 'https://api.z.ai/api/paas/v4' }).chat('glm-4.5-flash'), label: 'glm-4.5-flash' };
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return { model: createAnthropic({ apiKey: anthropicKey })('claude-haiku-4-5-20251001'), label: 'claude-haiku-4-5-20251001' };
  }
  return null;
}

export async function rerankFiles(
  query: string,
  candidates: RetrievedFile[],
  fileContents: Map<string, string>,
): Promise<RetrievedFile[]> {
  if (candidates.length < MIN_CANDIDATES_TO_RERANK) return candidates;

  const provider = getRerankModel();
  if (!provider) return candidates;

  const listing = candidates
    .map((c, i) => {
      const preview = (fileContents.get(c.path) ?? '').slice(0, 300).replace(/\s+/g, ' ').trim();
      return `[${i}] ${c.path}\n${preview}`;
    })
    .join('\n\n');

  try {
    const result = await Promise.race([
      generateText({
        model: provider.model,
        system:
          'You rank code files by relevance to a task. Respond with ONLY a comma-separated list of the given indices, most relevant first. Omit indices for files that are not actually relevant to the task. No prose, no explanation.',
        prompt: `Task: ${query}\n\nCandidate files:\n${listing}`,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('rerank timeout')), RERANK_TIMEOUT_MS)),
    ]);

    const ranked = result.text
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(i => Number.isInteger(i) && i >= 0 && i < candidates.length);

    if (ranked.length === 0) return candidates; // unparseable -- don't trust it

    const seen = new Set<number>();
    const reordered: RetrievedFile[] = [];
    for (const i of ranked) {
      if (seen.has(i)) continue;
      seen.add(i);
      reordered.push(candidates[i]);
    }
    // Anything the model didn't mention (a truncated/partial response, or a
    // borderline file it silently skipped) is demoted to the end rather than
    // dropped -- reranking should improve ORDER, never silently cost recall
    // to a malformed model response.
    for (let i = 0; i < candidates.length; i++) {
      if (!seen.has(i)) reordered.push(candidates[i]);
    }
    return reordered;
  } catch {
    return candidates; // timeout, provider error -- keep RRF order
  }
}
