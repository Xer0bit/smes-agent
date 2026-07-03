/**
 * Gemini context caching for tool-using (build/edit/fix/feature) runs.
 *
 * Gemini's cachedContents API rejects any generateContent request that sets
 * `tools`/`toolConfig`/`system_instruction` if a cachedContent is attached —
 * those must be baked into the cache itself instead. This module:
 *   1. Converts our Zod-based ToolSet into Gemini functionDeclarations.
 *   2. Creates a cachedContent containing systemInstruction + those declarations.
 *   3. Exposes a small AI SDK v6 LanguageModelMiddleware that strips
 *      tools/toolConfig from the outbound request whenever a cache is active —
 *      local tool-call *execution* in streamText/generateText is unaffected,
 *      since that dispatch table is separate from what gets sent over the wire.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolSet } from 'ai';
import type { LanguageModelMiddleware } from 'ai';
import { logger } from '../utils/logger.js';

// ── Gemini OpenAPI-subset schema types (functionDeclarations.parameters) ─────
interface GeminiSchema {
  type?: string;
  description?: string;
  enum?: string[];
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  nullable?: boolean;
}

/** Convert a JSON Schema node (as produced by zod-to-json-schema) into Gemini's OpenAPI-subset schema. */
function jsonSchemaToGemini(node: any): GeminiSchema {
  if (!node || typeof node !== 'object') return { type: 'STRING' };

  // Nullable via anyOf/oneOf [X, {type: 'null'}] (zod .optional()/.nullable() shape)
  const variants: any[] = node.anyOf ?? node.oneOf ?? [];
  if (variants.length > 0) {
    const nonNull = variants.find((v) => v?.type !== 'null');
    if (nonNull) {
      const converted = jsonSchemaToGemini(nonNull);
      return { ...converted, nullable: true };
    }
  }

  const typeMap: Record<string, string> = {
    string: 'STRING',
    number: 'NUMBER',
    integer: 'INTEGER',
    boolean: 'BOOLEAN',
    object: 'OBJECT',
    array: 'ARRAY',
  };

  const jsType = Array.isArray(node.type) ? node.type.find((t: string) => t !== 'null') : node.type;
  const gType = typeMap[jsType] ?? 'STRING';

  const out: GeminiSchema = { type: gType };
  if (node.description) out.description = String(node.description).slice(0, 1000);
  if (Array.isArray(node.enum)) out.enum = node.enum.map(String);

  if (gType === 'OBJECT' && node.properties) {
    out.properties = {};
    for (const [key, val] of Object.entries(node.properties)) {
      out.properties[key] = jsonSchemaToGemini(val);
    }
    if (Array.isArray(node.required) && node.required.length > 0) {
      out.required = node.required;
    }
  }

  if (gType === 'ARRAY' && node.items) {
    out.items = jsonSchemaToGemini(node.items);
  }

  return out;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiSchema;
}

/** Convert our ToolSet (as passed to streamText) into Gemini's functionDeclarations array. */
export function toolSetToGeminiDeclarations(toolSet: ToolSet): GeminiFunctionDeclaration[] {
  const decls: GeminiFunctionDeclaration[] = [];
  for (const [name, tool] of Object.entries(toolSet)) {
    const zodSchema = (tool as any).inputSchema;
    if (!zodSchema || typeof zodSchema.safeParse !== 'function') continue; // not a zod schema — skip defensively
    let jsonSchema: any;
    try {
      jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' });
    } catch (err) {
      logger.warn(`[GeminiToolCache] Failed to convert schema for tool "${name}":`, err);
      continue;
    }
    decls.push({
      name,
      description: ((tool as any).description ?? '').slice(0, 8000),
      parameters: jsonSchemaToGemini(jsonSchema),
    });
  }
  return decls;
}

// ── Cache creation (tools + system instruction baked in) ─────────────────────

interface CachedEntry { name: string; expiresAt: number }
const geminiToolCaches = new Map<string, CachedEntry>();

/**
 * Creates (or reuses) a Gemini cachedContent containing the static system
 * prompt AND the tool function declarations. Returns null on any failure —
 * callers must treat this as best-effort and fall back to uncached requests.
 */
export async function createGeminiToolCache(
  systemContent: string,
  toolSet: ToolSet,
  modelId: string,
  apiKey: string,
): Promise<string | null> {
  // Gemini requires a minimum content size (~1024 tokens) to create a cache —
  // below that, the create call itself fails, so skip it and run uncached.
  if (systemContent.length < 4096) return null;

  const toolNames = Object.keys(toolSet).sort().join(',');
  const cacheKey = `${modelId}:${systemContent.length}:${systemContent.slice(0, 80)}:${toolNames}`;
  const existing = geminiToolCaches.get(cacheKey);
  if (existing && existing.expiresAt > Date.now()) return existing.name;

  const declarations = toolSetToGeminiDeclarations(toolSet);
  if (declarations.length === 0) return null; // nothing to bake in — not worth a cache

  const fullModelId = modelId.startsWith('models/') ? modelId : `models/${modelId}`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: fullModelId,
          systemInstruction: { parts: [{ text: systemContent }] },
          tools: [{ functionDeclarations: declarations }],
          contents: [],
          ttl: '600s', // 10-minute TTL — enough for a 30-45 step run
        }),
        signal: AbortSignal.timeout(5000), // never block the run if the cache API is slow
      },
    );
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      logger.warn(`[GeminiToolCache] Create failed ${resp.status}: ${errText.slice(0, 300)}`);
      return null;
    }
    const data = await resp.json().catch(() => ({})) as { name?: string };
    if (!data.name) return null;
    geminiToolCaches.set(cacheKey, { name: data.name, expiresAt: Date.now() + 9 * 60 * 1000 });
    logger.info(`[GeminiToolCache] Created: ${data.name} (${declarations.length} tools, ${systemContent.length} chars)`);
    return data.name;
  } catch (err: any) {
    logger.warn('[GeminiToolCache] Error:', err?.message ?? err);
    return null;
  }
}

// ── Middleware: strip tools/toolConfig from the outbound request ─────────────
// when a cache is active. Local tool-call execution in streamText/generateText
// is driven by the `tools` object passed to streamText itself — that dispatch
// table is untouched. This middleware only affects what gets serialized into
// the actual HTTP request body sent to Gemini.

export function createStripToolsForCacheMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      const cachedContent = (params.providerOptions as any)?.google?.cachedContent;
      if (!cachedContent) return params;
      return {
        ...params,
        tools: undefined,
        toolChoice: undefined,
      };
    },
  };
}
