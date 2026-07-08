
import { streamText, generateText, ToolSet, stepCountIs, jsonSchema, wrapLanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import AdmZip from 'adm-zip';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
// pdf-parse is a CJS module — use createRequire so ESM can import it
let _pdfParse: ((buf: Buffer) => Promise<{ text: string }>) | null = null;
try { _pdfParse = _require('pdf-parse'); } catch { /* not installed — PDF text extraction disabled */ }
import type { AgentContext } from '../agent-tools/types.js';
import { safeJoin } from '../agent-tools/types.js';
import { writeFileTool } from '../agent-tools/write_file.js';
import { placeAssetTool } from '../agent-tools/place_asset.js';
import { readFileTool } from '../agent-tools/read_file.js';
import { readFilesTool } from '../agent-tools/read_files.js';
import { listFilesTool } from '../agent-tools/list_files.js';
import { deleteFileTool } from '../agent-tools/delete_file.js';
import { renameFileTool } from '../agent-tools/rename_file.js';
import { grepTool } from '../agent-tools/grep.js';
import { editFileTool } from '../agent-tools/edit_file.js';
import { getBuildErrorsTool } from '../agent-tools/get_build_errors.js';
import { runCommandTool } from '../agent-tools/run_command.js';
import { thinkTool } from '../agent-tools/think.js';
import { getDatabaseSchemaTool } from '../agent-tools/get_database_schema.js';
import { queryDatabaseTool } from '../agent-tools/query_database.js';
import { provisionDatabaseTool } from '../agent-tools/provision_database.js';
import { writeEdgeFunctionTool } from '../agent-tools/write_edge_function.js';
import { searchOrgKnowledgeTool } from '../agent-tools/search_org_knowledge.js';
import { sanitizeFileContent, sanitizeConfigFile } from '../agent-tools/sanitize.js';
import ts from 'typescript';
import { getAppBuilderBuildSystemPrompt, getAppBuilderSystemPrompt, MICRO_SYSTEM_PROMPT, getFixSystemPrompt, getEditSystemPrompt } from '../prompts/app-builder.prompt.js';
import { PRE_INSTALLED_PACKAGES } from './baseTemplateService.js';
import { RunStateLedger } from './runStateLedger.js';
import { canonicalizeModelId, DEFAULT_FREE_MODEL, DEFAULT_PRIMARY_MODEL } from '../config/models.js';
import { indexFile, indexFiles, retrieveRelevantFiles, extractSymbols } from '../knowledgebase/index.js';
import { captureThumbnail } from './thumbnailService.js';
import { createStripToolsForCacheMiddleware } from './geminiToolCache.service.js';
import { lookupFailureFix, storeFailureFix } from './failureMemory.service.js';

// Supabase service-role client for agent_runs tracking (fire-and-forget)
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const SUPPRESS_RECOVERY_UI = (process.env.AGENT_SUPPRESS_RECOVERY_UI ?? '1') !== '0';

// Circuit breaker: providers that returned a credit/billing error this server session.
// Avoids retrying a dead provider on every subsequent run until restart.
const billingFailedProviders = new Set<string>();
const MAX_PROMPT_CHARS = 8_000;
const MAX_OLDER_SUMMARY_CHARS = 6_000;
const MAX_FILE_TREE_CHARS = 5_000;   // trimmed: agent uses list_files for full tree
const MAX_ATTACHMENT_CONTEXT_CHARS = 24_000;

function clampContextSection(label: string, value: string, maxChars: number): string {
  if (!value || value.length <= maxChars) return value;
  const kept = value.slice(0, maxChars);
  const omitted = value.length - maxChars;
  return `${kept}\n\n[${label} truncated: omitted ${omitted} chars to keep prompt stable]`;
}

// ─── Per-project KB batch-index guard ────────────────────────────────────────
// Tracks which projects have had their full file tree indexed this server process.
// Prevents re-scanning on every request — individual file writes handle updates.
const kbBatchIndexedProjects = new Set<string>();

// ─── Per-project agent lock ──────────────────────────────────────────────────
// Prevents concurrent agent runs on the same project from interleaving file writes.
const projectAgentLocks = new Map<string, Promise<void>>();

function acquireProjectLock(projectId: string): { release: () => void; ready: Promise<void> } {
  const prev = projectAgentLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  projectAgentLocks.set(projectId, prev.then(() => gate));
  return { release, ready: prev };
}

// ─── Document text extraction ────────────────────────────────────────────────

/** MIME types where we can extract readable text from the binary file. */
const EXTRACTABLE_DOC_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         // .xlsx
]);

async function extractDocumentText(filePath: string, mimeType: string): Promise<string | null> {
  try {
    if (mimeType === 'application/pdf') {
      if (!_pdfParse) return null;
      const buf = await fs.promises.readFile(filePath);
      const result = await _pdfParse(buf);
      return result.text?.trim() || null;
    }
    const zip = new AdmZip(filePath);

    if (mimeType.includes('wordprocessingml')) {
      // .docx — main content is in word/document.xml
      const entry = zip.getEntry('word/document.xml');
      if (!entry) return null;
      const xml = entry.getData().toString('utf8');
      // Strip XML tags, keep text content from <w:t> elements
      const textParts: string[] = [];
      const tagRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
      let match: RegExpExecArray | null;
      while ((match = tagRegex.exec(xml)) !== null) {
        textParts.push(match[1]);
      }
      // Also detect paragraph breaks
      return xml
        .replace(/<w:p\b[^>]*\/>/g, '\n')
        .replace(/<w:p\b[^>]*>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim() || textParts.join(' ').trim() || null;
    }

    if (mimeType.includes('spreadsheetml')) {
      // .xlsx — shared strings in xl/sharedStrings.xml, sheet data in xl/worksheets/sheet1.xml
      const ssEntry = zip.getEntry('xl/sharedStrings.xml');
      const sheetEntry = zip.getEntry('xl/worksheets/sheet1.xml');
      const parts: string[] = [];

      if (ssEntry) {
        const ssXml = ssEntry.getData().toString('utf8');
        const stringRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let m: RegExpExecArray | null;
        while ((m = stringRegex.exec(ssXml)) !== null) {
          parts.push(m[1]);
        }
      }
      if (sheetEntry) {
        const sheetXml = sheetEntry.getData().toString('utf8');
        // Extract inline string values
        const valRegex = /<v>([\s\S]*?)<\/v>/g;
        let m: RegExpExecArray | null;
        while ((m = valRegex.exec(sheetXml)) !== null) {
          if (!parts.includes(m[1])) parts.push(m[1]);
        }
      }

      return parts.length > 0 ? parts.join(' | ') : null;
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Vision / snapshot helpers ───────────────────────────────────────────────

/**
 * Returns true when vision analysis describes a screenshot/UI capture shared as context,
 * not an image the user wants embedded as a project asset.
 */
function isReferenceScreenshot(analysis: string): boolean {
  const lower = analysis.toLowerCase();
  const screenshotSignals = /screenshot|application window|browser window|web app(?:lication)? interface|software interface|ui capture|dark.*ui|builder.*ui|editor.*ui|app.*screenshot|screen capture|dashboard.*screenshot|admin.*panel|dev.*tool|inspector|console.*log|page layout|full page|webpage/i;
  // Diagrams, wireframes, and annotated sketches shared to explain a concept/layout are
  // reference-only — the agent should use them as visual context, not embed them as assets.
  const diagramSignals = /\bdiagram\b|\bwireframe\b|\bsketch\b|\bmockup\b|\bflowchart\b|\bannot(?:at|ation)\b|\barchitecture\b|\blayout.*(?:diagram|plan|sketch)\b|\bexplanat/i;
  const strongAssetSignals = /\b(?:standalone logo|isolated logo|transparent background|brand mark only|icon-only|favicon source|logo file)\b/i;
  // Screenshots and diagrams/wireframes are reference context; treat them as such unless
  // the analysis strongly indicates this is a standalone brand asset.
  return (screenshotSignals.test(lower) || diagramSignals.test(lower)) && !strongAssetSignals.test(lower);
}

/**
 * Returns true when the filename alone strongly suggests a screenshot (no vision needed).
 * Covers OS-generated names (Screenshot 2024-..., screen-shot, snap, etc.) and
 * clipboard pastes (image.png, paste*.png, clipboard*).
 */
function isScreenshotFilename(name: string): boolean {
  return /^(?:screenshot|screen[ _-]?shot|screen[ _-]?capture|screen[ _-]?grab|snap(?:shot)?|capture|scr\d|grab|paste|clipboard|untitled|image\d*\.png$)/i.test(name)
    || /screenshot/i.test(name);
}

/**
 * Returns true when the user's prompt contains explicit intent to use an attached image
 * as a project asset (logo, hero, background, etc.).
 * When false and no vision confirmation, we treat the image as reference-only — safer default.
 */
function hasEmbedIntent(prompt: string): boolean {
  const explicitAssetAction = /\b(?:use|set|add|make|embed|insert|place|put|replace|swap|apply)\b[\s\S]{0,40}\b(?:logo|favicon|hero|banner|background(?: image)?|icon|image|photo|picture|avatar)\b/i;
  const shorthandAssetAction = /\b(?:use as|set as|add as)\s+(?:the\s+)?(?:logo|favicon|hero|banner|background|icon|image|photo|picture|avatar)\b/i;
  const screenshotContext = /\b(?:screenshot|screen[ -]?shot|screen[ -]?capture|ui|interface|page|current state|existing state|bug|issue|error|fix)\b/i;

  if (explicitAssetAction.test(prompt) || shorthandAssetAction.test(prompt)) return true;
  // Mentioning words like "logo" inside bug reports about screenshots should not
  // force embedding behavior unless there is explicit action intent.
  if (screenshotContext.test(prompt)) return false;
  return false;
}

/** True when the selected provider/model is capable of accepting image content. */
function supportsVision(providerName: string, modelId: string): boolean {
  if (providerName === 'deepseek') return false;
  if (providerName === 'anthropic') return true; // claude-3+ all support vision
  if (providerName === 'gemini')    return true;
  // OpenAI — only vision-capable models
  return modelId.includes('gpt-4o') || modelId.includes('vision');
}


async function analyzeImageWithVision(
  imageBase64: string,
  mimeType: string,
  fileName: string,
  aiProvider: any,
  abortSignal?: AbortSignal,
): Promise<string> {
  try {
    const result = await generateText({
      model: aiProvider,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: imageBase64, mimeType } as any,
            {
              type: 'text',
              text: 'Describe this image in 2-3 sentences for a web developer. First classify it as exactly one of: (1) screenshot/UI capture — a full application window or web page; (2) diagram/wireframe/sketch/annotation — a hand-drawn or diagrammatic layout, flowchart, architecture drawing, or annotated explanation; or (3) standalone asset — an isolated logo, icon, photo, or graphic intended for direct use in a project. IMPORTANT: if a screenshot contains logos within the UI, it is still a screenshot. Then state main colours, shapes/content, and its likely role in a web project.',
            },
          ],
        },
      ],
      maxOutputTokens: 200,
      ...(abortSignal ? { abortSignal } : {}),
    });
    return result.text.trim();
  } catch {
    return `image file "${fileName}"`;
  }
}

const SNAPSHOT_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.cache', '.tmp', 'coverage']);

/** Dotfiles that SHOULD be included in snapshots (rollback needs them). */
const SNAPSHOT_INCLUDE_DOTFILES = new Set(['.env.local', '.env.production', '.gitignore', '.eslintrc.json', '.prettierrc']);

/**
 * Persistent snapshots root — survives server restarts.
 * Configurable via SNAPSHOTS_DIR env var (recommended on VPS: /var/www/ecomgear/snapshots).
 * Falls back to ~/.ecomgear/snapshots locally.
 */
const SNAPSHOTS_DIR = process.env.SNAPSHOTS_DIR
  ? path.resolve(process.env.SNAPSHOTS_DIR)
  : path.join(os.homedir(), '.ecomgear', 'snapshots');

/**
 * Max snapshots kept per project. Oldest are pruned when the limit is exceeded.
 * At ~1-5 MB per snapshot, 20 versions ≈ 20-100 MB per project.
 */
const MAX_SNAPSHOTS_PER_PROJECT = 20;

/**
 * Atomically snapshot project files to snapshotDir.
 * Copies into a temp dir first, then renames — so a snapshot is either
 * fully present or not present at all (no half-written states).
 */
async function snapshotProject(appPath: string, snapshotDir: string): Promise<void> {
  if (!fs.existsSync(appPath)) return;
  const tmpDir = snapshotDir + '.tmp-' + Date.now();
  const copyDir = async (src: string, dest: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(src, { withFileTypes: true }); } catch { return; }
    await fs.promises.mkdir(dest, { recursive: true });
    for (const entry of entries) {
      if (SNAPSHOT_SKIP.has(entry.name)) continue;
      // Include select dotfiles needed for rollback; skip all other hidden files/dirs
      if (entry.name.startsWith('.') && !SNAPSHOT_INCLUDE_DOTFILES.has(entry.name)) continue;
      const srcPath  = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await copyDir(srcPath, destPath);
      } else {
        try { await fs.promises.copyFile(srcPath, destPath); } catch { /* skip */ }
      }
    }
  };
  try {
    await copyDir(appPath, tmpDir);
    // Atomic rename — the snapshot appears fully formed or not at all.
    // If snapshotDir already exists (shouldn't), remove it first.
    try { await fs.promises.rm(snapshotDir, { recursive: true, force: true }); } catch { /* ok */ }
    await fs.promises.rename(tmpDir, snapshotDir);
  } catch (err) {
    // Cleanup temp dir on failure so we don't leave partial copies around.
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    throw err;
  }
}

/** Restore a previously snapshotted project back to appPath. */
export async function restoreSnapshot(snapshotDir: string, appPath: string): Promise<void> {
  // Remove non-essential files first so stale ones don't linger
  const clearDir = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SNAPSHOT_SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await clearDir(p);
      else try { await fs.promises.unlink(p); } catch { /* skip */ }
    }
  };
  const copyDir = async (src: string, dest: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(src, { withFileTypes: true }); } catch { return; }
    await fs.promises.mkdir(dest, { recursive: true });
    for (const entry of entries) {
      const srcPath  = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) await copyDir(srcPath, destPath);
      else try { await fs.promises.copyFile(srcPath, destPath); } catch { /* skip */ }
    }
  };
  await clearDir(appPath);
  await copyDir(snapshotDir, appPath);
}

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function sseWrite(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Build AI SDK tool set from our ToolDefinition array ─────────────────────

// ─── Server-side context window ("brain") ────────────────────────────────────
// Compacts older step messages to keep token count manageable across 25 steps.
// The agent can save important facts via save_memory tool; those survive compaction.

/** How many recent steps keep full detail (older steps get compacted) */
const KEEP_RECENT_STEPS = 2;
/** Step number (0-indexed) at which compaction begins */
const COMPACT_AFTER_STEP = 3;

// ─── Gemini run-level context cache ──────────────────────────────────────────
// Caches the full system prompt at the start of each run so steps 2-N are
// cache hits (~80% prompt token savings from step 2 onward).

interface GeminiRunCache { name: string; expiresAt: number; }
const geminiRunCaches = new Map<string, GeminiRunCache>();

async function createGeminiRunCache(
  systemContent: string,
  modelId: string,
  apiKey: string,
): Promise<string | null> {
  // Gemini requires at least ~1024 tokens (≈4096 chars) to create a cache
  if (systemContent.length < 4096) return null;

  // Reuse an existing cache for the same system content hash within its TTL
  const cacheKey = `${modelId}:${systemContent.length}:${systemContent.slice(0, 80)}`;
  const existing = geminiRunCaches.get(cacheKey);
  if (existing && existing.expiresAt > Date.now()) return existing.name;

  // Gemini REST API requires "models/..." prefix
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
          contents: [],
          ttl: '600s', // 10-minute TTL — enough for a 30-step run
        }),
        signal: AbortSignal.timeout(5000), // don't block the run if cache API is slow
      },
    );
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn(`[GeminiCache] Create failed ${resp.status}: ${errText.slice(0, 160)}`);
      return null;
    }
    const data = await resp.json().catch(() => ({})) as { name?: string };
    if (!data.name) return null;
    // Store with 9-min TTL (1-min safety buffer before actual 10-min expiry)
    geminiRunCaches.set(cacheKey, { name: data.name, expiresAt: Date.now() + 9 * 60 * 1000 });
    console.log(`[GeminiCache] Created: ${data.name}`);
    return data.name;
  } catch (err: any) {
    console.warn('[GeminiCache] Error:', err?.message ?? err);
    return null;
  }
}

/** Truncate a string with an indicator of how much was removed. */
function truncStr(s: string | undefined, max: number): string {
  if (!s || s.length <= max) return s ?? '';
  const lines = s.split('\n').length;
  return s.substring(0, max) + `\n...[truncated, was ${lines} lines / ${s.length} chars]`;
}

/**
 * Shorten tool-call args in an assistant message part.
 * Mutates `part.args` in-place (caller deep-cloned the messages).
 */
/**
 * Convert a file path into a concise human-readable label.
 * e.g. "src/pages/HomePage.tsx" → "Home page"
 *      "src/components/ProductCard.tsx" → "Product card"
 *      "src/hooks/useCart.ts" → "Cart hook"
 */
function filePathToLabel(filePath: string): string {
  const base = filePath.replace(/\.[^.]+$/, '').split('/').pop() ?? filePath;
  // Convert CamelCase/PascalCase to words
  const words = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
  if (words.startsWith('use ')) return words.replace('use ', '') + ' hook';
  if (filePath.includes('/pages/')) return words + ' page';
  if (filePath.includes('/components/')) return words;
  if (filePath.includes('/hooks/')) return words + ' hook';
  if (filePath.includes('/lib/') || filePath.includes('/utils/')) return words + ' utilities';
  if (filePath.includes('/services/')) return words + ' service';
  if (filePath.includes('/types')) return words + ' types';
  if (base === 'App') return 'app shell';
  if (base === 'main') return 'app entry';
  return words;
}

/**
 * Derive a concise, human-friendly status line from a completed step's tool calls.
 * Priority: think > write_file/edit_file groups > other tools.
 */
function deriveStepStatus(toolCalls: any[], toolResults: any[]): string | null {
  if (toolCalls.length === 0) return null;

  // 1. think tool — extract first meaningful sentence of the thought
  const thinkCall = toolCalls.find((tc: any) => tc.toolName === 'think');
  if (thinkCall) {
    const thought: string = thinkCall.args?.thought ?? '';
    if (thought) {
      // Take the first non-empty sentence (up to ~80 chars)
      const firstSentence = thought
        .replace(/\n+/g, ' ')
        .replace(/^(okay|alright|so|now|first|let me|i will|i'll|i need to|i should|i'm going to)\s*/i, '')
        .split(/[.!?]/)[0]
        .trim();
      if (firstSentence.length > 8) {
        const capped = firstSentence.length > 80
          ? firstSentence.slice(0, 77) + '...'
          : firstSentence;
        // Capitalise first letter
        return capped.charAt(0).toUpperCase() + capped.slice(1);
      }
    }
    return 'Thinking...';
  }

  // 2. save_memory
  if (toolCalls.some((tc: any) => tc.toolName === 'save_memory')) {
    return 'Saving project context...';
  }

  // 3. write_file / edit_file — group by file and describe what's being built
  const writeCalls = toolCalls.filter((tc: any) => tc.toolName === 'write_file' || tc.toolName === 'edit_file');
  if (writeCalls.length > 0) {
    const labels = writeCalls
      .map((tc: any) => filePathToLabel(tc.args?.path ?? tc.args?.file_path ?? ''))
      .filter(Boolean);
    const unique = Array.from(new Set(labels));
    if (unique.length === 1) {
      const verb = writeCalls[0].toolName === 'edit_file' ? 'Updating' : 'Building';
      return `${verb} ${unique[0]}...`;
    }
    if (unique.length === 2) return `Building ${unique[0]} and ${unique[1]}...`;
    if (unique.length >= 3) return `Building ${unique[0]}, ${unique[1]} and ${unique.length - 2} more...`;
  }

  // 4. read_file — show what's being read
  const readCalls = toolCalls.filter((tc: any) => tc.toolName === 'read_file');
  if (readCalls.length > 0) {
    const label = filePathToLabel(readCalls[0].args?.path ?? readCalls[0].args?.file_path ?? '');
    return label ? `Reading ${label}...` : 'Reading project files...';
  }

  // 5. delete_file / rename_file
  if (toolCalls.some((tc: any) => tc.toolName === 'delete_file')) return 'Removing unused files...';
  if (toolCalls.some((tc: any) => tc.toolName === 'rename_file')) return 'Renaming files...';

  // 6. list_files / grep
  if (toolCalls.some((tc: any) => tc.toolName === 'list_files' || tc.toolName === 'grep')) {
    return 'Scanning project structure...';
  }

  // 7. get_build_errors
  if (toolCalls.some((tc: any) => tc.toolName === 'get_build_errors')) return 'Checking for errors...';

  // 8. run_command
  const runCall = toolCalls.find((tc: any) => tc.toolName === 'run_command');
  if (runCall) {
    const cmd: string = runCall.args?.command ?? '';
    if (cmd.includes('install') || cmd.includes('add ')) {
      const pkg = cmd.split(/install|add/)[1]?.trim().split(' ')[0] ?? '';
      return pkg ? `Installing ${pkg}...` : 'Installing packages...';
    }
    return 'Running command...';
  }

  return null;
}


function compactToolCallArgs(part: any): void {
  const args = part.args;
  if (!args || typeof args !== 'object') return;
  switch (part.toolName) {
    case 'write_file':
      if (typeof args.content === 'string' && args.content.length > 200) {
        const lines = args.content.split('\n').length;
        args.content = `[compacted] ${lines} lines written to ${args.path ?? 'file'} — see Run Change Journal for details`;
      }
      break;
    case 'edit_file':
      if (typeof args.diff === 'string' && args.diff.length > 300) {
        const searchSnippet = args.diff.match(/<<<<<<< SEARCH\n([\s\S]{0,60})/)?.[1]?.replace(/\n/g, '↵') ?? '';
        args.diff = `[compacted] edit to ${args.path ?? 'file'} — target: "${searchSnippet}" — see Run Change Journal`;
      }
      break;
    case 'think':
      if (typeof args.thought === 'string' && args.thought.length > 500) {
        args.thought = truncStr(args.thought, 600);
      }
      break;
  }
}

/**
 * Shorten tool-result content in a tool message part.
 * Mutates `part.result` in-place.
 */
function compactToolResult(part: any): void {
  const result = typeof part.result === 'string' ? part.result : JSON.stringify(part.result ?? '');
  switch (part.toolName) {
    case 'read_file':
      if (result.length > 300) {
        const lines = result.split('\n').length;
        part.result = `[compacted] ${lines}-line file read — agent saw full content at step time. Call read_file again if current content needed.`;
      }
      break;
    case 'grep':
      if (result.length > 300) part.result = truncStr(result, 200);
      break;
    case 'list_files':
      if (result.length > 400) part.result = truncStr(result, 300);
      break;
    case 'get_build_errors':
      if (result.length > 500) part.result = truncStr(result, 400);
      break;
    // write_file, edit_file, delete_file, rename_file, think results are already short
  }
}

/**
 * Compact older step messages to reduce token count.
 * Keeps the original user/history messages + last KEEP_RECENT_STEPS steps
 * fully intact. Older steps have verbose tool args/results truncated.
 * Brain memories are injected as a user note before recent steps.
 */
function compactStepMessages(
  messages: Array<any>,
  stepNumber: number,
  brainMemory: string[],
): Array<any> {
  // No compaction needed for early steps
  if (stepNumber < COMPACT_AFTER_STEP && brainMemory.length === 0) return messages;

  // Deep clone to avoid mutating SDK internal state
  const msgs: Array<any> = JSON.parse(JSON.stringify(messages));

  // Sanitize: JSON.stringify drops `undefined` values, so tool-call args can
  // become missing after the deep clone.  Anthropic rejects tool_use.input that
  // is not an object, so ensure args is always at least {}.
  for (const msg of msgs) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool-call' && (part.args === undefined || part.args === null || typeof part.args !== 'object')) {
          part.args = {};
        }
      }
    }
  }

  // Find where step-generated messages begin (first assistant message after user/history)
  let stepStartIdx = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'assistant' && Array.isArray(msgs[i].content)) {
      stepStartIdx = i;
      break;
    }
  }
  if (stepStartIdx === 0 && msgs.length > 0 && msgs[0].role !== 'assistant') {
    // No assistant messages yet — nothing to compact
    return messages;
  }

  // Each completed step adds 2 messages: assistant (tool calls) + tool (results)
  const stepMsgCount = msgs.length - stepStartIdx;
  const completedStepPairs = Math.floor(stepMsgCount / 2);
  const compactUpTo = Math.max(0, completedStepPairs - KEEP_RECENT_STEPS);

  if (stepNumber >= COMPACT_AFTER_STEP && compactUpTo > 0) {
    for (let pairIdx = 0; pairIdx < compactUpTo; pairIdx++) {
      const assistantIdx = stepStartIdx + pairIdx * 2;
      const toolIdx = assistantIdx + 1;

      // Compact assistant message (tool call args — file contents, diffs)
      const aMsg = msgs[assistantIdx];
      if (aMsg && Array.isArray(aMsg.content)) {
        for (const part of aMsg.content) {
          if (part.type === 'tool-call') compactToolCallArgs(part);
        }
        // Also compact any text parts (agent thinking/explanation between tool calls)
        for (const part of aMsg.content) {
          if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 400) {
            part.text = truncStr(part.text, 300);
          }
        }
      }

      // Compact tool message (results — file contents from read_file, grep, etc.)
      const tMsg = msgs[toolIdx];
      if (tMsg && Array.isArray(tMsg.content)) {
        for (const part of tMsg.content) {
          if (part.type === 'tool-result') compactToolResult(part);
        }
      }
    }

    const compactedTokensEst = Math.ceil(JSON.stringify(msgs).length / 3.5);
    console.log(`[Brain] Step ${stepNumber}: compacted ${compactUpTo} older steps, ~${compactedTokensEst} tokens est.`);
  }

  // Inject brain memories as context before recent steps
  if (brainMemory.length > 0) {
    const brainContent =
      '[Agent Brain — important facts you saved during this run. These persist across context compaction.]\n' +
      brainMemory.map((m, i) => `${i + 1}. ${m}`).join('\n');
    const insertIdx = stepStartIdx + Math.max(0, compactUpTo * 2);
    msgs.splice(insertIdx, 0, {
      role: 'user' as const,
      content: brainContent,
    });
  }

  return msgs;
}

// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fast syntax-only TS/JSX check for a single file's content — NOT a full
 * type-checked `tsc --noEmit` project build (that needs a persistent
 * ts.LanguageService per project; out of scope here). This only catches
 * structural breakage (unclosed brackets, malformed JSX, stray tokens) —
 * exactly the failure mode that used to only surface in the cold, expensive
 * post-run repair pass. Runs in milliseconds since it's a single-file parse.
 * Returns a short diagnostic string, or null if the file parses clean.
 */
function checkTsSyntaxInLoop(relPath: string, content: string): string | null {
  const normalizedPath = relPath.replace(/\\/g, '/');
  if (!/(^|\/)src\/.*\.(tsx|jsx)$/i.test(normalizedPath)) return null;
  try {
    const result = ts.transpileModule(content, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
      },
      reportDiagnostics: true,
      fileName: relPath,
    });
    if (result.diagnostics && result.diagnostics.length > 0) {
      const errors = result.diagnostics
        .slice(0, 3)
        .map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))
        .join('; ');
      return errors;
    }
    return null;
  } catch {
    return null; // never block the tool result on a transpiler crash
  }
}

/**
 * Deterministically derive a route path from a page component name, matching
 * the naming convention already documented in app-builder.prompt.ts:
 *   HomePage       → "/"        (home is ALWAYS "/" per prompt rule)
 *   AboutPage      → "/about"
 *   ContactUsPage  → "/contact-us"
 *   PricingPage    → "/pricing"
 */
function deriveRoutePath(componentName: string): string {
  const base = componentName.replace(/Page$/, '');
  if (/^(home|index|landing)$/i.test(base) || base === '') return '/';
  // PascalCase / camelCase → kebab-case
  const kebab = base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
  return `/${kebab}`;
}

/**
 * Deterministic codegen replacement for the LLM-based "App.tsx fix pass".
 * Given the list of page files on disk, generates a complete src/App.tsx
 * with HashRouter + a Route per page — zero LLM calls, zero wiring failures.
 * Mirrors exactly the rules the old LLM prompt enforced (HashRouter only,
 * home page at "/", default export name === file basename).
 */
function generateAppTsxFromPages(pagePaths: string[]): string {
  const pages = pagePaths.map(p => {
    const componentName = path.basename(p, path.extname(p));
    return { componentName, importPath: `./pages/${componentName}`, route: deriveRoutePath(componentName) };
  });

  // Home page ("/") must be listed first for readability; stable sort keeps
  // the rest in their original (disk-read) order.
  pages.sort((a, b) => (a.route === '/' ? -1 : b.route === '/' ? 1 : 0));

  const imports = pages.map(p => `import ${p.componentName} from "${p.importPath}";`).join('\n');
  const routes = pages.map(p => `        <Route path="${p.route}" element={<${p.componentName} />} />`).join('\n');

  return `import { HashRouter, Routes, Route } from "react-router-dom";
${imports}

export default function App() {
  return (
    <HashRouter>
      <Routes>
${routes}
      </Routes>
    </HashRouter>
  );
}
`;
}

/**
 * Given a file's content before and after a successful repair, extract the
 * minimal changed region as a SEARCH/REPLACE block for failure-memory storage.
 * Returns null when the change is too large/sprawling to be a useful template
 * for a DIFFERENT file's content (e.g. a full-file rewrite) — only tight,
 * localized fixes are worth remembering as a reusable diff.
 */
function buildMinimalSearchReplace(before: string, after: string): string | null {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start++;

  let endB = beforeLines.length - 1;
  let endA = afterLines.length - 1;
  while (endB >= start && endA >= start && beforeLines[endB] === afterLines[endA]) { endB--; endA--; }

  const searchLines = beforeLines.slice(start, endB + 1);
  const replaceLines = afterLines.slice(start, endA + 1);

  // Reject sprawling changes — not a reusable template, and too large to be
  // worth matching verbatim against a different file's content later.
  if (searchLines.length === 0 || searchLines.length > 15 || replaceLines.length > 15) return null;

  const searchText = searchLines.join('\n');
  const replaceText = replaceLines.join('\n');
  return `<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`;
}

function buildToolSet(ctx: AgentContext, brainMemory: string[]): ToolSet {
  const defs = [
    thinkTool,
    getBuildErrorsTool,
    writeFileTool,
    readFileTool,
    readFilesTool,
    listFilesTool,
    deleteFileTool,
    renameFileTool,
    placeAssetTool,
    grepTool,
    editFileTool,
    runCommandTool, // npm install/uninstall only — whitelist enforced inside the tool
    getDatabaseSchemaTool,
    queryDatabaseTool,
    provisionDatabaseTool,
    writeEdgeFunctionTool,
    ...(ctx.ecgMcp ? [searchOrgKnowledgeTool] : []),
  ];

  const toolSet: ToolSet = {};
  for (const def of defs) {
    toolSet[def.name] = {
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (args: any) => {
        // ── Read-before-write guard ──────────────────────────────────────────
        // Copilot-style discipline: the agent must read an existing file before
        // overwriting it. This prevents clobbering unread content and forces the
        // model to work with the true current state of each file.
        if ((def.name === 'write_file' || def.name === 'edit_file') && typeof args.path === 'string') {
          const relPath = args.path;
          if (ctx.readFiles && !ctx.readFiles.has(relPath)) {
            try {
              const fullPath = safeJoin(ctx.appPath, relPath);
              if (fs.existsSync(fullPath)) {
                return (
                  `BLOCKED: You haven't read "${relPath}" yet in this run. ` +
                  `Call read_file("${relPath}") first to get the current content, then proceed with your edit. ` +
                  `This prevents accidental overwrites of unread code.`
                );
              }
            } catch { /* path traversal — let the tool itself reject it */ }
          }

          // ── Prefer-edit guard ────────────────────────────────────────────────
          // If the agent tries to write_file on a file it already read and the file
          // has more than 40 lines, redirect it to edit_file unless this is truly
          // a full structural rebuild. Prevents the "rewrite the whole file to change
          // two lines" pattern that silently deletes untouched code.
          if (def.name === 'write_file' && ctx.readFiles?.has(relPath)) {
            try {
              const fullPath = safeJoin(ctx.appPath, relPath);
              if (fs.existsSync(fullPath)) {
                const existing = fs.readFileSync(fullPath, 'utf8');
                const lineCount = existing.split('\n').length;
                if (lineCount > 40) {
                  return (
                    `PREFER EDIT: "${relPath}" exists with ${lineCount} lines. ` +
                    `Use edit_file with SEARCH/REPLACE blocks to change only the lines that need updating — ` +
                    `do NOT rewrite the whole file. This prevents accidentally deleting untouched code. ` +
                    `Only call write_file on this file again if you are completely rebuilding its structure from scratch.`
                  );
                }
              }
            } catch { /* ignore — let write_file handle path errors */ }
          }
        }
        // ── Pre-write TSX/JSX sanity check ─────────────────────────────────────
        // Catches the most common agent mistake: writing return() / JSX at module
        // scope with no function wrapper, which crashes React rendering.
        if (def.name === 'write_file' && typeof args.path === 'string' && typeof args.content === 'string') {
          const ext = args.path.split('.').pop()?.toLowerCase() ?? '';
          if (ext === 'tsx' || ext === 'jsx') {
            const content: string = args.content;
            const hasExportDefault = /export\s+default\s+(function|const|class|memo|forwardRef)/m.test(content);
            // Detect return( or return ( at column 0 — classic module-scope return
            const moduleReturn = /^return\s*[\n(]/m.test(content);
            if (moduleReturn && !hasExportDefault) {
              return (
                `BLOCKED: "${args.path}" has a return() statement at module scope with no export default function. ` +
                `A React component MUST be wrapped in a function: \`export default function ComponentName() { return ( ... ); }\`. ` +
                `Rewrite the file with a proper function wrapper before calling write_file again.`
              );
            }
          }
        }

        try {
          const result = await def.execute(args, ctx);
          // ── Track successful reads ─────────────────────────────────────────
          // Mark file as read so subsequent write_file/edit_file calls are allowed.
          if (def.name === 'read_file' && typeof args.path === 'string' && ctx.readFiles) {
            ctx.readFiles.add(args.path);
          }
          // ── In-loop TS syntax feedback ───────────────────────────────────────
          // Check the file the model JUST wrote/edited, with hot context still
          // in the conversation. Cheaper and more reliable than the cold post-run
          // repair pass, which re-reads context from scratch after the run ends.
          // Only fires on success (an ERROR: result already told the model what's wrong).
          if (
            (def.name === 'write_file' || def.name === 'edit_file') &&
            typeof args.path === 'string' &&
            typeof result === 'string' &&
            !result.startsWith('ERROR') &&
            !result.startsWith('BLOCKED')
          ) {
            try {
              const fullPath = safeJoin(ctx.appPath, args.path);
              const finalContent = fs.readFileSync(fullPath, 'utf8');
              const diagnostic = checkTsSyntaxInLoop(args.path, finalContent);
              if (diagnostic) {
                return `${result}\n\n⚠️ SYNTAX CHECK FAILED for ${args.path}: ${diagnostic}\nFix this now with edit_file before moving to the next file — this file will not compile as-is.`;
              }
            } catch { /* file may not exist yet or be unreadable — don't block the tool result */ }
          }
          return result;
        } catch (err: any) {
          const errMsg = err?.message ?? String(err);
          const errCode = (err as NodeJS.ErrnoException)?.code ?? '';
          // Truncated args for context (avoid leaking huge file contents)
          const argsSummary = JSON.stringify(args, (_k, v) =>
            typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v
          );
          console.warn(`[AgentTool] ${def.name} failed:`, errMsg, '| args:', argsSummary);
          const codeNote = errCode ? ` (${errCode})` : '';
          return `ERROR: Tool "${def.name}" failed${codeNote} — ${errMsg}. Args: ${argsSummary}. You MUST address this error before proceeding. Either retry with corrected arguments or use a different approach.`;
        }
      },
    };
  }

  // Brain memory tool — agent can persist key facts that survive context compaction
  toolSet['save_memory'] = {
    description:
      'Save an important fact, decision, or state to your persistent brain memory for this run. ' +
      'Use this EARLY and OFTEN to remember: architecture decisions, which files you created/modified, ' +
      'key user requirements, error patterns you spotted, and anything you\'ll need in later steps. ' +
      'Your older tool call history gets compacted to save tokens — only facts saved here are guaranteed to persist.',
    inputSchema: jsonSchema({
      type: 'object' as const,
      properties: {
        memory: {
          type: 'string',
          description: 'The fact, decision, or context to remember. Be specific and concise.',
        },
      },
      required: ['memory'],
    }),
    execute: async (args: any) => {
      const text = typeof args.memory === 'string' ? args.memory.trim() : String(args.memory);
      if (text.length > 500) {
        brainMemory.push(text.substring(0, 500));
      } else {
        brainMemory.push(text);
      }
      return `Memory saved (${brainMemory.length} total). This will persist even as older context is compacted.`;
    },
  };

  return toolSet;
}

// ─── Agent params / result types ──────────────────────────────────────────────

export interface AgentRunParams {
  /** User's prompt */
  prompt: string;
  /** Project ID (used as workspace identifier) */
  projectId: string;
  /** Absolute path to the project on disk */
  appPath: string;
  /** Model name override (default: claude-3-5-haiku-20241022) */
  model?: string;
  /** Runtime mode selected by backend orchestration */
  mode?: 'build' | 'plan';
  /** Existing files to provide as context */
  existingFiles?: Array<{ path: string; content: string }>;
  /**
   * Recent conversation history (already-cleaned, no ecomgear tags).
   * The current user prompt is NOT included — it is always appended last.
   * Max recommended: last 6 messages (3 user+assistant pairs).
   */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * One-line summaries of turns older than the history window.
   * Injected into the system prompt to give context without burning tokens.
   */
  olderSummary?: string;
  /** Typed prompt intent flags computed by the backend request boundary. */
  promptIntent?: {
    isWebsiteBuild?: boolean;
    hasIntegrationRequest?: boolean;
    /** Cost-routing tier from intentClassifier — drives MAX_STEPS and model override */
    requestTier?: 'micro' | 'fix' | 'edit' | 'feature' | 'build';
  };
  /** Files attached by the user in the chat message (images, docs, etc.) */
  attachments?: Array<{
    name: string;
    type: string;
    category: 'image' | 'document';
    tempPath: string;
  }>;
  /** Project knowledge from KnowledgeSettings (custom system prompt + context notes) */
  projectKnowledge?: {
    customSystemPrompt: string;
    contextNotes: string;
  };
  /** Project secrets — injected as env var hints for the agent, never echoed to user */
  projectSecrets?: Array<{ key_name: string; key_value: string }>;
  /** Express response object for SSE streaming */
  res: Response;
  /** Authenticated user ID for tracking */
  userId?: string;
  /** Optional external abort signal (e.g. client disconnected) */
  abortSignal?: AbortSignal;
}

export interface AgentRunResult {
  /** All files written during this run */
  filesToWrite: Array<{ path: string; content: string }>;
  filesToDelete: string[];
  renames: Array<{ from: string; to: string }>;
  dependencies: string[];
  summary: string;
}

// ─── File tree builder ────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.cache', '.dyad']);

function buildFileTree(dir: string, base: string, prefix = ''): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  const filtered = entries.filter(e => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));
  const lines: string[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i];
    const isLast = i === filtered.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (entry.isDirectory()) {
      lines.push(`${prefix}${connector}${entry.name}/`);
      const sub = buildFileTree(path.join(dir, entry.name), base, prefix + childPrefix);
      if (sub) lines.push(sub);
    } else {
      lines.push(`${prefix}${connector}${entry.name}`);
    }
  }

  return lines.join('\n');
}


function getProjectFileTree(appPath: string): string {
  if (!fs.existsSync(appPath)) return '';
  const tree = buildFileTree(appPath, appPath);
  return tree ? `./\n${tree}` : './\n(empty)';
}

// ─── LLM retry / fallback helpers ─────────────────────────────────────────────

/** Check if an error is retryable (rate limit, overloaded, server error). */
function isRetryableError(err: any): boolean {
  // Google errors use data.error.code (numeric) while err.status may be the string "UNAVAILABLE"
  const status = err?.status ?? err?.statusCode ?? err?.data?.error?.code ?? err?.data?.error?.status;
  const numericStatus = typeof status === 'number' ? status : parseInt(String(status), 10);
  if (numericStatus === 429 || numericStatus === 529 || (numericStatus >= 500 && numericStatus < 600)) return true;
  const msg = [
    err?.message,
    err?.cause?.message,
    err?.data?.error?.message,
    err?.responseBody,
    err?.error?.message,
  ].filter(Boolean).join(' ').toLowerCase();
  return (
    msg.includes('overloaded') ||
    msg.includes('overloaded_error') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('capacity') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('service unavailable') ||
    msg.includes('currently unavailable') ||
    msg.includes('unavailable') ||
    msg.includes('ai_nooutputgeneratederror') ||
    msg.includes('no output generated') ||
    msg.includes('stream terminated')
  );
}

/** Check if an error is specifically a rate limit (429). Needs longer backoff. */
function isRateLimitError(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.data?.error?.status;
  if (status === 429) return true;
  const msg = [
    err?.message,
    err?.cause?.message,
    err?.data?.error?.message,
    err?.responseBody,
  ].filter(Boolean).join(' ').toLowerCase();
  return msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429');
}

/** Strip raw API details from error messages before sending to users. */
function sanitizeErrorMessage(err: any): string {
  const msg = (err?.message ?? String(err));
  if (isRateLimitError(err)) return 'The AI model is temporarily busy. Please wait a moment and try again.';
  if (isAuthOrBillingError(err)) return 'AI service authentication issue — switching to backup model.';
  if (isNetworkError(err)) return 'Connection to AI service failed. Trying backup model...';
  // Strip long API error details (org IDs, URLs, etc.)
  const cleaned = msg.replace(/\(org:\s*[^)]+\)/gi, '').replace(/For details.*$/i, '').replace(/You can see.*$/i, '').replace(/You may also.*$/i, '').trim();
  return cleaned.length > 200 ? cleaned.slice(0, 200) + '...' : cleaned;
}

function isAuthOrBillingError(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.data?.error?.status;
  if (status === 401 || status === 403) return true;
  const msg = [err?.message, err?.cause?.message, err?.error?.message].filter(Boolean).join(' ').toLowerCase();
  let bodyMsg = '';
  let parsedBody: any = null;
  if (err?.data?.error?.message) {
    bodyMsg = err.data.error.message.toLowerCase();
  } else if (err?.responseBody) {
    try { parsedBody = JSON.parse(err.responseBody); bodyMsg = parsedBody?.error?.message?.toLowerCase() ?? ''; } catch {}
  }
  // z.ai error code 1113 = insufficient balance / no resource package
  const zaiCode = String(parsedBody?.error?.code ?? err?.data?.error?.code ?? '');
  if (zaiCode === '1113') return true;
  const combined = `${msg} ${bodyMsg}`;
  return (
    combined.includes('organization') && combined.includes('disabled') ||
    combined.includes('balance too low') ||
    combined.includes('balance is too low') ||
    combined.includes('insufficient balance') ||
    combined.includes('no resource package') ||
    combined.includes('please recharge') ||
    combined.includes('credit balance') ||
    combined.includes('insufficient') && combined.includes('credit') ||
    combined.includes('billing') && (combined.includes('inactive') || combined.includes('error')) ||
    combined.includes('exceeded') && combined.includes('spending cap') ||
    combined.includes('usage limits') ||
    combined.includes('api usage limit') ||
    combined.includes('regain access') ||
    combined.includes('invalid.*api.*key') ||
    combined.includes('invalid api key') ||
    combined.includes('invalid x-api-key') ||
    combined.includes('authentication') && combined.includes('failed')
  );
}

/**
 * Check if an error is a network-level failure that should immediately trigger
 * the fallback provider rather than retrying the same unreachable endpoint.
 * EAI_AGAIN = DNS temporary failure, ENOTFOUND = DNS not found,
 * ECONNREFUSED = port closed, ECONNRESET / ETIMEDOUT = transport level.
 */
function isNetworkError(err: any): boolean {
  const msg = [
    err?.message,
    err?.cause?.message,
    err?.error?.message,
    err?.responseBody,
  ].filter(Boolean).join(' ').toLowerCase();
  return (
    msg.includes('eai_again') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('terminated') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('cannot connect to api') ||
    msg.includes('getaddrinfo')
  );
}

/** Returns true for transient mid-stream drops (ECONNRESET, terminated) vs true connectivity failures. */
function isTransientStreamDrop(err: any): boolean {
  const msg = [
    err?.message,
    err?.cause?.message,
  ].filter(Boolean).join(' ').toLowerCase();
  return msg.includes('econnreset') || msg.includes('terminated') || msg.includes('socket hang up');
}

/** Extract retry-after duration in milliseconds from a rate-limit error's response headers. */
function getRetryAfterMs(err: any): number | null {
  const headers = err?.responseHeaders ?? err?.headers ?? {};
  const retryAfterStr = headers['retry-after'] ?? headers['Retry-After'];
  if (retryAfterStr) {
    const seconds = parseInt(retryAfterStr, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  // Fallback: compute from the reset timestamp Anthropic includes
  const resetStr = headers['anthropic-ratelimit-input-tokens-reset'] ?? headers['anthropic-ratelimit-requests-reset'];
  if (resetStr) {
    const ms = new Date(resetStr).getTime() - Date.now();
    if (!isNaN(ms) && ms > 0) return ms;
  }
  return null;
}

function getDefaultAgentTimeoutMs(_providerName: string): number {
  // 8 minutes default to reduce false timeouts on long multi-file runs,
  // especially when provider fallback and repair loops are active.
  return 480_000;
}

function isLikelyFixRequest(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(fix|broken|bug|issue|error|failing|fails|not working|doesn't work|does not work|crash|blank|repair)\b/.test(text)
    || text.includes('build error')
    || text.includes('preview error')
    || text.includes('runtime error');
}

function buildFallbackCandidates(primaryProviderName: string, primaryModelId?: string): string[] {
  const configuredFallback = process.env.AI_FALLBACK_MODEL || DEFAULT_FREE_MODEL;
  const candidates = Array.from(new Set([
    configuredFallback,
    DEFAULT_FREE_MODEL,
    'glm-4.5',
    'glm-4.5-air',
    'gemini-2.5-pro',
    'deepseek-chat',
    'claude-sonnet-4-6',
  ]));
  return candidates.filter((mid) => {
    // Never retry the exact same model that just failed
    if (mid === primaryModelId) return false;
    if (mid.toLowerCase().startsWith('glm')) {
      // Allow GLM-to-GLM fallback for transient errors — but not if ZAI is billing-failed
      return Boolean(process.env.ZAI_API_KEY)
        && process.env.AI_DISABLE_ZAI !== '1'
        && !billingFailedProviders.has('zai');
    }
    if (mid.includes('deepseek')) {
      return Boolean(process.env.DEEPSEEK_API_KEY)
        && process.env.AI_DISABLE_DEEPSEEK !== '1'
        && primaryProviderName !== 'deepseek'
        && !billingFailedProviders.has('deepseek');
    }
    if (mid.includes('gemini')) {
      // Allow same-provider (gemini) fallback to a different model — e.g. 2.5-pro → 2.0-flash
      return Boolean(process.env.GEMINI_API_KEY)
        && process.env.AI_DISABLE_GEMINI !== '1'
        && !billingFailedProviders.has('gemini');
    }
    const hasAnthropic = Boolean(process.env.AI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY) && process.env.AI_DISABLE_ANTHROPIC !== '1';
    return hasAnthropic && primaryProviderName !== 'anthropic' && !billingFailedProviders.has('anthropic');
  });
}

/** Create an AI SDK provider from a model ID. Returns null if API key is missing. */
function createProviderForModel(mid: string): { provider: any; providerName: string } | null {
  if (mid.toLowerCase().startsWith('glm')) {
    if (process.env.AI_DISABLE_ZAI === '1') return null;
    const key = process.env.ZAI_API_KEY;
    if (!key) return null;
    return { provider: createOpenAI({ apiKey: key, baseURL: 'https://api.z.ai/api/paas/v4' }).chat(mid), providerName: 'zai' };
  } else if (mid.includes('deepseek')) {
    if (process.env.AI_DISABLE_DEEPSEEK === '1') return null;
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return null;
    return { provider: createOpenAI({ apiKey: key, baseURL: 'https://api.deepseek.com/v1' }).chat(mid), providerName: 'deepseek' };
  } else if (mid.includes('gemini')) {
    if (process.env.AI_DISABLE_GEMINI === '1') return null;
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    return { provider: createGoogleGenerativeAI({ apiKey: key })(mid), providerName: 'gemini' };
  } else {
    if (process.env.AI_DISABLE_ANTHROPIC === '1') return null;
    const key = process.env.AI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    return { provider: createAnthropic({ apiKey: key })(mid), providerName: 'anthropic' };
  }
}

function resolveProviderWithFallback(requestedModelId: string): { provider: any; providerName: string; modelId: string } {
  const normalizedRequested = requestedModelId || process.env.AI_MODEL || DEFAULT_FREE_MODEL;
  const fallbackModel = process.env.AI_FALLBACK_MODEL || DEFAULT_FREE_MODEL;
  const candidates = [
    normalizedRequested,
    process.env.AI_MODEL || DEFAULT_FREE_MODEL,
    fallbackModel,
    DEFAULT_FREE_MODEL,
    DEFAULT_PRIMARY_MODEL,
    'deepseek-chat',
  ].filter(Boolean);

  const uniqueCandidates = Array.from(new Set(candidates));
  const triedProviders: string[] = [];
  for (const candidate of uniqueCandidates) {
    const providerGuess = candidate.toLowerCase().startsWith('glm') ? 'zai'
      : candidate.includes('deepseek') ? 'deepseek'
      : candidate.includes('gemini') ? 'gemini' : 'anthropic';
    // Skip providers circuit-broken by a billing/credit error this session
    if (billingFailedProviders.has(providerGuess)) {
      console.warn(`[AgentLoop] Skipping ${providerGuess} (billing circuit open) — trying next candidate`);
      continue;
    }
    const resolved = createProviderForModel(candidate);
    if (resolved) {
      if (candidate !== normalizedRequested) {
        console.warn(`[AgentLoop] Model fallback: requested=${normalizedRequested}, using=${candidate} (${resolved.providerName})`);
      }
      return { ...resolved, modelId: candidate };
    }
    // Track why this candidate was skipped
    const provider = candidate.toLowerCase().startsWith('glm') ? 'zai'
      : candidate.includes('deepseek') ? 'deepseek'
      : candidate.includes('gemini') ? 'gemini' : 'anthropic';
    if (!triedProviders.includes(provider)) triedProviders.push(provider);
  }

  // Build actionable error message listing which keys are missing
  const missingKeys: string[] = [];
  if (!process.env.DEEPSEEK_API_KEY) missingKeys.push('DEEPSEEK_API_KEY');
  if (!process.env.GEMINI_API_KEY) missingKeys.push('GEMINI_API_KEY');
  if (!(process.env.AI_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)) missingKeys.push('ANTHROPIC_API_KEY');
  if (process.env.AI_DISABLE_ANTHROPIC === '1') missingKeys.push('(Anthropic disabled via AI_DISABLE_ANTHROPIC=1)');

  throw new Error(
    `No configured AI provider is available. Tried models: ${uniqueCandidates.join(', ')}. ` +
    `Missing environment variables: ${missingKeys.join(', ')}. ` +
    `Add at least one API key in Admin settings.`
  );
}


export async function runAgentLoop(params: AgentRunParams): Promise<AgentRunResult> {
  const { prompt, projectId, appPath, model, mode, existingFiles, history, olderSummary, promptIntent, attachments, res, userId, abortSignal } = params;

  // ── Per-project mutex: prevent interleaved file writes from concurrent runs ──
  const lock = acquireProjectLock(projectId);
  await lock.ready;
  try {
  return await _runAgentLoopInner(params);
  } finally {
    lock.release();
    // Clean up the lock chain entry if we're the last in queue
    const current = projectAgentLocks.get(projectId);
    if (current) current.then(() => {
      // If nothing else queued after us, remove the entry to avoid memory leak
      projectAgentLocks.delete(projectId);
    }).catch(() => projectAgentLocks.delete(projectId));
  }
}

async function _runAgentLoopInner(params: AgentRunParams): Promise<AgentRunResult> {
  const { prompt, projectId, appPath, model, mode, existingFiles, history, olderSummary, promptIntent, attachments, projectKnowledge, projectSecrets, res, userId, abortSignal } = params;

  // Dynamic step budget: map request tier to a proportionate step ceiling.
  // Values must match TIER_MAX_STEPS in intentClassifier.ts.
  const _tier = promptIntent?.requestTier;
  const MAX_STEPS = _tier === 'micro'   ?  8
                  : _tier === 'fix'     ? 28
                  : _tier === 'edit'    ? 25
                  : _tier === 'feature' ? 35
                  : _tier === 'build'   ? 45
                  // Legacy fallback when no tier provided (e.g. old clients)
                  : ((promptIntent?.isWebsiteBuild ?? false) || prompt.length > 600) ? 45 : 25;

  // Tier-based token cap. The USD cost cap ($1.50) is the ultimate backstop.
  // These limits just prevent runaway loops — they must be high enough that
  // the final response step is never cut off (agent does work then goes silent).
  // Observed abort patterns: fix hits 124-130K, edit hits 239K → raised accordingly.
  const TIER_TOKEN_CAP = _tier === 'micro'   ?  80_000
                       : _tier === 'fix'     ? 350_000
                       : _tier === 'edit'    ? 450_000
                       : _tier === 'feature' ? 600_000
                       : /* build / legacy */  800_000;
  const RUN_TOKEN_CAP = process.env.AGENT_TOKEN_CAP
    ? Math.min(parseInt(process.env.AGENT_TOKEN_CAP, 10), TIER_TOKEN_CAP)
    : TIER_TOKEN_CAP;

  const boundedPrompt = clampContextSection('User prompt', prompt, MAX_PROMPT_CHARS);
  const boundedOlderSummary = olderSummary
    ? clampContextSection('Earlier conversation summary', olderSummary, MAX_OLDER_SUMMARY_CHARS)
    : undefined;
  const runtimeMode: 'build' | 'plan' = mode === 'plan' ? 'plan' : 'build';

  const requestedModelId = canonicalizeModelId(model || process.env.AI_MODEL, DEFAULT_PRIMARY_MODEL);

  if (requestedModelId === 'deepseek-reasoner') {
    throw new Error('DeepSeek Reasoner (R1) does not support the necessary tool-calling features. Please select deepseek-chat instead.');
  }

  const resolvedModel = resolveProviderWithFallback(requestedModelId);
  const aiProvider = resolvedModel.provider;
  const providerName = resolvedModel.providerName;
  const modelId = resolvedModel.modelId;

  // Whether this model can accept image content parts in messages
  const visionCapable = supportsVision(providerName, modelId);
  // Collected image data for (a) vision message content and (b) pre-flight analysis
  const imageVisionData: Array<{ name: string; type: string; base64: string; safeName: string }> = [];

  // ─── agent_runs tracking (fire-and-forget) ───────────────────────────────────
  let agentRunId: string | null = null;
  if (supabase && userId) {
    const { data } = await supabase
      .from('agent_runs')
      .insert({ project_id: projectId, user_id: userId, prompt, model: modelId })
      .select('id')
      .single();
    agentRunId = data?.id ?? null;
  }

  let stepCount = 0;

  // ── Per-run token accounting ──────────────────────────────────────────────
  // Tracks every token category across all steps so we can log cost per step
  // and store an accurate total in agent_runs at the end.
  const runTokens = {
    inputTokens:       0,
    outputTokens:      0,
    cacheReadTokens:   0,
    cacheWriteTokens:  0,
    get total()        { return this.inputTokens + this.outputTokens + this.cacheReadTokens + this.cacheWriteTokens; },
  };

  // Per-model pricing per 1M tokens
  const PRICE = modelId.includes('claude')
    ? { input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  }  // Claude Sonnet 4.6
    : modelId.includes('gemini-3.1-pro-preview')
    ? { input: 1.25,   output: 10.00,  cacheRead: 0.31,  cacheWrite: 0.00  }  // Gemini 3.1 Pro (thinking)
    : modelId.includes('gemini-2.5-pro')
    ? { input: 1.25,   output: 10.00,  cacheRead: 0.31,  cacheWrite: 0.00  }  // Gemini 2.5 Pro
    : modelId.includes('gemini')
    ? { input: 0.075,  output: 0.30,   cacheRead: 0.01875, cacheWrite: 0.00 } // Gemini 2.5 Flash
    : modelId.includes('deepseek')
    ? { input: 0.27,   output: 1.10,   cacheRead: 0.07,  cacheWrite: 0.00  }  // DeepSeek Chat
    : { input: 3.00,   output: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75  };  // fallback: Claude
  function calcCost(inp: number, out: number, cacheR: number, cacheW: number): number {
    return (inp * PRICE.input + out * PRICE.output + cacheR * PRICE.cacheRead + cacheW * PRICE.cacheWrite) / 1_000_000;
  }

  // Collected operation log
  const filesToWrite: Array<{ path: string; content: string }> = [];
  const filesToDelete: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  const dependencies: string[] = [];
  const filesEdited: string[] = [];
  let summary = '';

  // Per-run change journal — created early so tools can record into it from the first step
  const runLedger = new RunStateLedger();

  // Build AgentContext
  const ctx: AgentContext = {
    appPath,
    projectId,
    userId,
    readFiles: new Set<string>(),
    pendingPreviewFiles: new Map<string, string>(),
    editFailures: new Map<string, number>(),
    buildErrorCallCount: 0,
    dbQueryCallCount: 0,
    previewServiceUrl: process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001',
    ledger: runLedger,
    ecgMcp: (() => {
      const url = projectSecrets?.find(s => s.key_name === 'ECG_MCP_URL')?.key_value;
      const token = projectSecrets?.find(s => s.key_name === 'ECG_MCP_TOKEN')?.key_value;
      return url ? { url, token } : undefined;
    })(),
    // reverseGraph is injected below after the import graph is built
    onXmlComplete: (xml: string) => {
      // Parse completed XML tags and record operations
      parseXmlOperation(xml, { filesToWrite, filesEdited, filesToDelete, renames, dependencies });
      // Stream the XML to the frontend
      sseWrite(res, 'tool-output', { xml });
    },
    onXmlStream: (xml: string) => {
      sseWrite(res, 'tool-streaming', { xml });
    },
    getDeclaredDependencies: () => [...dependencies],
  };

  // ── Snapshot disk state BEFORE agent writes ─────────────────────────────────
  // preAgentDiskSnapshot is used for: (a) file context assembly, (b) surgical revert
  // during validation, (c) full rollback on catastrophic failure.
  //
  // Tier-gated loading: micro only snapshots the target file (zero wasted I/O);
  // all other tiers read the full project as before.
  const SNAP_SKIP_FILES = new Set(['package-lock.json', '.ecomgear-hash', '.DS_Store', '.env', '.env.local', '.env.production', '.gitignore']);
  const preAgentDiskSnapshot = new Map<string, string>();
  const promptLower = prompt.toLowerCase();

  if (_tier === 'micro') {
    // ── MICRO FAST PATH ──────────────────────────────────────────────────────
    // A color/text/spacing change touches exactly one file. Find it with a
    // targeted scan — no full disk read, no import graph, no KB query.
    const promptWords = promptLower.split(/[\s,./'"!?()[\]{}]+/).filter(w => w.length > 2);
    const findMentioned = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { findMentioned(fullPath); continue; }
        const relPath = path.relative(appPath, fullPath);
        const fname = entry.name.toLowerCase().replace(/\.(tsx?|jsx?|css)$/, '');
        if (fname && promptWords.some(w => fname.includes(w) || w.includes(fname))) {
          try { preAgentDiskSnapshot.set(relPath, fs.readFileSync(fullPath, 'utf8')); } catch {}
        }
      }
    };
    try { findMentioned(path.join(appPath, 'src')); } catch {}
    // If nothing matched by name, grab App.tsx as fallback orientation
    if (preAgentDiskSnapshot.size === 0) {
      const appTsx = path.join(appPath, 'src', 'App.tsx');
      try {
        const rel = path.relative(appPath, appTsx);
        preAgentDiskSnapshot.set(rel, fs.readFileSync(appTsx, 'utf8'));
      } catch {}
    }
  } else {
    // ── FULL DISK SNAPSHOT (fix / edit / feature / build) ────────────────────
    const snapDisk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (SNAP_SKIP_FILES.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { snapDisk(fullPath); }
        else {
          const relPath = path.relative(appPath, fullPath);
          try { preAgentDiskSnapshot.set(relPath, fs.readFileSync(fullPath, 'utf8')); } catch {}
        }
      }
    };
    try { snapDisk(appPath); } catch {}
  }

  // Unified file source: prefer frontend-sent existingFiles, fall back to disk snapshot.
  const fileSources: Array<{ path: string; content: string }> =
    (existingFiles && existingFiles.length > 0)
      ? existingFiles
      : Array.from(preAgentDiskSnapshot.entries()).map(([p, c]) => ({ path: p, content: c }));

  // KB batch index — runs once per project per server boot in the background.
  // Skip for micro (snapshot is partial) and fix (no benefit for error diagnosis).
  if (_tier !== 'micro' && _tier !== 'fix' && projectId && !kbBatchIndexedProjects.has(projectId) && fileSources.length > 0) {
    kbBatchIndexedProjects.add(projectId);
    indexFiles(projectId, fileSources).catch(() => {});
  }

  // Build a lightweight import graph — skip for micro (single file, no cross-file analysis needed).
  const importGraph = new Map<string, Set<string>>();
  const reverseGraph = new Map<string, Set<string>>(); // importers of each file
  if (_tier !== 'micro') {
    for (const f of fileSources) {
      if (!/\.(tsx?|jsx?)$/.test(f.path)) continue;
      const imports = new Set<string>();
      const importRegex = /(?:import\s+.*?from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
      let m: RegExpExecArray | null;
      while ((m = importRegex.exec(f.content)) !== null) {
        const raw = m[1] || m[2];
        if (!raw || raw.startsWith('react') || raw.startsWith('@radix') || raw.startsWith('class-variance') || raw.startsWith('clsx') || raw.startsWith('tailwind') || raw.startsWith('lucide')) continue;
        const resolved = raw.startsWith('.')
          ? path.posix.normalize(path.posix.join(path.posix.dirname(f.path), raw)).replace(/^\.\//, '')
          : raw.startsWith('@/') ? raw.replace('@/', 'src/') : null;
        if (resolved) {
          for (const candidate of fileSources) {
            const base = candidate.path.replace(/\.(tsx?|jsx?)$/, '');
            if (resolved === candidate.path || resolved === base || resolved + '/index' === base) {
              imports.add(candidate.path);
              if (!reverseGraph.has(candidate.path)) reverseGraph.set(candidate.path, new Set());
              reverseGraph.get(candidate.path)!.add(f.path);
            }
          }
        }
      }
      importGraph.set(f.path, imports);
    }
  }

  // Wire reverseGraph into ctx so tools can emit dependency warnings
  ctx.reverseGraph = reverseGraph;

  // Find directly mentioned files
  const directlyMentioned = new Set<string>();
  for (const f of fileSources) {
    const fname = f.path.toLowerCase().split('/').pop()?.replace(/\.(tsx?|jsx?)$/, '') ?? '';
    if (fname && promptLower.includes(fname)) directlyMentioned.add(f.path);
  }

  // Expand to imports/importers of mentioned files (1 hop) — skip for micro
  const relatedByImport = new Set<string>();
  const importersOfMentioned = new Set<string>();
  if (_tier !== 'micro') {
    for (const mentionedPath of directlyMentioned) {
      for (const imp of importGraph.get(mentionedPath) ?? []) relatedByImport.add(imp);
      for (const importer of reverseGraph.get(mentionedPath) ?? []) relatedByImport.add(importer);
    }
    for (const mentionedPath of directlyMentioned) {
      for (const importer of reverseGraph.get(mentionedPath) ?? []) importersOfMentioned.add(importer);
    }
  }

  // Always-include critical files
  const criticalFiles = new Set(['src/App.tsx', 'src/index.css', 'src/lib/utils.ts', 'package.json']);

  // KB vector retrieval — skip for micro (partial snapshot) and fix (2s latency with no benefit;
  // fix agent calls get_build_errors first and reads only the broken file).
  const kbScores = new Map<string, number>(); // path → 0-50 bonus points
  if (_tier !== 'micro' && _tier !== 'fix' && projectId) {
    try {
      const kbResults = await Promise.race([
        retrieveRelevantFiles(projectId, prompt, fileSources, {
          maxFiles: 6,
          graphExpansion: false,
          mentionedPaths: [...directlyMentioned],
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('kb timeout')), 2000)),
      ]);
      // Multiply by 80 so a strong KB hit (score 0.8) = 64 pts — enough to beat the
      // criticalFiles baseline (60) and actually influence file selection.
      for (const r of kbResults) kbScores.set(r.path, Math.round(r.score * 80));
    } catch {
      // Non-fatal — heuristic sort still works without KB
    }
  }

  const sortedFiles = fileSources.slice().sort((a, b) => {
    const aScore = directlyMentioned.has(a.path) ? 100
      : relatedByImport.has(a.path) ? 80
      : importersOfMentioned.has(a.path) ? 70
      : criticalFiles.has(a.path) ? 60
      : a.path.startsWith('src/pages/') ? 40
      : a.path.startsWith('src/components/') && !a.path.includes('/ui/') ? 30
      : 0;
    const bScore = directlyMentioned.has(b.path) ? 100
      : relatedByImport.has(b.path) ? 80
      : importersOfMentioned.has(b.path) ? 70
      : criticalFiles.has(b.path) ? 60
      : b.path.startsWith('src/pages/') ? 40
      : b.path.startsWith('src/components/') && !b.path.includes('/ui/') ? 30
      : 0;
    const aFinal = aScore + (kbScores.get(a.path) ?? 0);
    const bFinal = bScore + (kbScores.get(b.path) ?? 0);
    if (aFinal !== bFinal) return bFinal - aFinal;
    return a.content.length - b.content.length;
  });

  // GitHub Copilot-style context selection: small focused working set — agent uses
  // read_file/list_files tools to pull anything else it needs.
  const MAX_CONTEXT_CHARS = parseInt(process.env.AI_MAX_CONTEXT_CHARS || '8000', 10);
  const MAX_CONTEXT_FILES = parseInt(process.env.AI_MAX_CONTEXT_FILES || '4', 10);
  const MAX_FILE_CONTEXT_CHARS = parseInt(process.env.AI_MAX_FILE_CONTEXT_CHARS || '800', 10);
  const MAX_MENTIONED_FILE_CONTEXT_CHARS = parseInt(process.env.AI_MAX_MENTIONED_FILE_CONTEXT_CHARS || '3000', 10);

  const cappedFiles: Array<{
    path: string;
    content: string;
    contextContent: string;
    truncated: boolean;
  }> = [];
  let totalChars = 0;

  for (const file of sortedFiles) {
    if (cappedFiles.length >= MAX_CONTEXT_FILES) break;

    const perFileCap = directlyMentioned.has(file.path)
      ? MAX_MENTIONED_FILE_CONTEXT_CHARS
      : MAX_FILE_CONTEXT_CHARS;
    const truncated = file.content.length > perFileCap;
    const contextContent = truncated
      ? `${file.content.slice(0, perFileCap)}\n\n/* peek only — call read_file("${file.path}") before editing */`
      : file.content;
    const entryChars = contextContent.length + file.path.length + 10;

    if (totalChars + entryChars > MAX_CONTEXT_CHARS) {
      continue;
    }

    cappedFiles.push({
      path: file.path,
      content: file.content,
      contextContent,
      truncated,
    });
    totalChars += entryChars;
  }

  if (cappedFiles.length === 0 && sortedFiles.length > 0) {
    const file = sortedFiles[0];
    const perFileCap = directlyMentioned.has(file.path)
      ? MAX_MENTIONED_FILE_CONTEXT_CHARS
      : MAX_FILE_CONTEXT_CHARS;
    const truncated = file.content.length > perFileCap;
    cappedFiles.push({
      path: file.path,
      content: file.content,
      contextContent: truncated
        ? `${file.content.slice(0, perFileCap)}\n\n/* peek only — call read_file("${file.path}") before editing */`
        : file.content,
      truncated,
    });
  }

  const existingFilesContext = cappedFiles
    .map((f) => `=== ${f.path} ===\n${f.contextContent}`)
    .join('\n\n');

  // Pre-mark non-truncated context files as already read — full content is in prompt.
  for (const f of cappedFiles) {
    if (!f.truncated && ctx.readFiles) ctx.readFiles.add(f.path);
  }

  // Build excluded/truncated file notes so agent knows to read_file before importing.
  const cappedPaths = new Set(cappedFiles.map(f => f.path));
  const excludedFileEntries = fileSources.filter(f => !cappedPaths.has(f.path));
  const excludedFiles = excludedFileEntries.map(f => f.path);
  const truncatedFiles = cappedFiles
    .filter(f => f.truncated)
    .map(f => f.path);

  // Signature-only preview for excluded files: symbol names + kind, no bodies.
  // Cheap (regex, already-in-memory content, no DB round-trip) and gives the
  // model enough to judge relevance without loading full text it may not need —
  // it still MUST call read_file before importing/editing, per the warning below.
  const MAX_SIGNATURE_FILES = 40;
  const signatureLines: string[] = [];
  for (const f of excludedFileEntries.slice(0, MAX_SIGNATURE_FILES)) {
    if (!/\.(tsx?|jsx?)$/.test(f.path)) { signatureLines.push(f.path); continue; }
    try {
      const symbols = extractSymbols(f.content);
      if (symbols.length === 0) { signatureLines.push(f.path); continue; }
      const sig = symbols.map(s => `${s.name}:${s.kind}`).join(', ');
      signatureLines.push(`${f.path} — ${sig}`);
    } catch {
      signatureLines.push(f.path);
    }
  }
  const remainingCount = excludedFiles.length - signatureLines.length;

  const excludedFilesNote = excludedFiles.length > 0
    ? `\n\n**WARNING: ${excludedFiles.length} file(s) exist in the project but their FULL contents are NOT shown above — only symbol signatures.** ` +
      `If you need to import from or edit any of these files, call \`read_file\` FIRST to see their actual content. ` +
      `NEVER guess implementation details of a file you haven't read — the signatures below only tell you WHAT exists, not HOW it works.\n` +
      `Files not in context (path — exported symbols:kind):\n${signatureLines.join('\n')}` +
      (remainingCount > 0 ? `\n(and ${remainingCount} more file(s) not shown)` : '')
    : '';
  const truncatedFilesNote = truncatedFiles.length > 0
    ? `\n\n**NOTE: ${truncatedFiles.length} file(s) are only partially shown above to save tokens.** ` +
      `Before editing beyond the visible preview, call \`read_file\` to fetch the exact current content.\n` +
      `Truncated files: ${truncatedFiles.slice(0, 20).join(', ')}${truncatedFiles.length > 20 ? ` (and ${truncatedFiles.length - 20} more)` : ''}`
    : '';

  // Always build a live file tree from disk — cheap and always accurate.
  // This is the agent's authoritative source for "what files exist right now."
  const liveFileTree = getProjectFileTree(appPath);

  // Build attachment context for the AI prompt.
  // Files live on disk in /tmp — read directly. No HTTP round-trip needed.
  // Text-based docs are inlined so the model can read them.
  // Images stay in /tmp until the agent explicitly calls place_asset to embed them.
  // This prevents any image from silently overwriting project assets before the agent
  // understands the user's intent.
  let attachmentContext = '';
  if (attachments && attachments.length > 0) {
    const TEXT_TYPES = new Set([
      'text/plain', 'text/csv', 'text/markdown',
      'application/json',
    ]);

    const parts: string[] = [];
    for (const att of attachments) {
      // Validate tempPath exists and is under /tmp to prevent path traversal
      const resolvedPath = path.resolve(att.tempPath);
      if (!resolvedPath.startsWith(os.tmpdir()) || !fs.existsSync(resolvedPath)) {
        parts.push(`- **${att.name}** — file not found or access denied`);
        continue;
      }

      if (att.category === 'image') {
        try {
          const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_');

          // Read bytes upfront — needed for both vision analysis and preview push
          let imgBytes: Buffer | null = null;
          try { imgBytes = await fs.promises.readFile(resolvedPath); } catch { /* best-effort */ }

          // ── Vision analysis — ALWAYS run for vision-capable models ──────────────────
          // The LLM must see the image to understand what it is:
          //   • A bug/UI screenshot shared to explain a problem
          //   • A diagram or annotated explanation
          //   • A logo / asset the user wants placed in the project
          // Never skip vision for filename heuristics alone — a file named
          // "screenshot_logo.png" might actually be a brand asset.
          let inlineAnalysis: string | null = null;
          let isRefScreenshot = false;

          if (visionCapable && imgBytes) {
            // Always hit the model — let it classify the image
            inlineAnalysis = await analyzeImageWithVision(
              imgBytes.toString('base64'), att.type, att.name, aiProvider, abortSignal,
            );
            isRefScreenshot = isReferenceScreenshot(inlineAnalysis);
          } else if (!visionCapable) {
            // No vision — fall back to filename heuristic + prompt intent
            if (isScreenshotFilename(att.name) || !hasEmbedIntent(prompt)) {
              isRefScreenshot = true;
              inlineAnalysis = 'No vision model available — treated as reference context based on filename/prompt.';
            }
          }

          // Always queue image bytes for inline delivery to the model in the main loop,
          // regardless of classification. For screenshots, the model needs to SEE the
          // bug/explanation. For assets, it needs to see what it's placing.
          if (imgBytes) {
            imageVisionData.push({
              name: att.name,
              type: att.type,
              base64: imgBytes.toString('base64'),
              safeName,
              _preAnalysis: inlineAnalysis ?? undefined,
            } as any);
          }

          if (isRefScreenshot) {
            // User shared a screenshot, diagram, or wireframe as visual context — reference only.
            // Do NOT copy to public/assets/; instruct the agent to use it as context only.
            parts.push(
              `- **Visual Context**: "${att.name}" — this image has been sent to you inline so you can SEE it.\n` +
              `  Visual analysis: ${inlineAnalysis ?? 'see image inline'}\n` +
              `  **Classification: reference context only.** Use it to understand the bug, UI state, layout intention, or explanation the user is describing. If this is a diagram or wireframe, use it to understand WHAT to build — do not embed the diagram itself in the project.\n` +
              `  **Do NOT call place_asset or embed this image in any project file.**`,
            );
          } else {
            // ── Image stays in /tmp — agent uses place_asset tool to explicitly place it ──
            // This prevents any image from silently overwriting project assets (e.g. logos)
            // before the agent understands the user's intent.

            // Scan existing public/assets/ for image files so the agent knows what's there
            // and can delete old logos/assets before placing the new one.
            let existingAssetsList = '';
            try {
              const assetsDir2 = path.join(appPath, 'public', 'assets');
              if (fs.existsSync(assetsDir2)) {
                const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);
                const existing = fs.readdirSync(assetsDir2)
                  .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
                  .map(f => `public/assets/${f}`);
                if (existing.length > 0) existingAssetsList = existing.join(', ');
              }
            } catch { /* best-effort */ }

            // NOTE: imageVisionData.push already done unconditionally above this if/else block

            const visualDesc = inlineAnalysis
              ? `\n  Visual analysis: ${inlineAnalysis}`
              : '';

            const oldAssetsNote = existingAssetsList
              ? `\n  Existing image assets: ${existingAssetsList}. If you are REPLACING one of these, call delete_file on the old path FIRST, then call place_asset.`
              : '';

            parts.push(
              `- **Image**: "${att.name}"${visualDesc}\n` +
              `  Temporary path: \`${resolvedPath}\`\n` +
              `  The image has NOT been copied to the project yet. To use it as a project asset:\n` +
              `  1. Determine WHERE it should go based on the user's message AND the visual analysis above (logo, hero, background, icon, etc.)\n` +
              `  2. If replacing an existing asset: call delete_file("old/path/here") FIRST\n` +
              `  3. Call place_asset(tmpPath: "${resolvedPath}", destName: "${safeName}") to copy it to public/assets/${safeName}\n` +
              `  4. Update every component/file that referenced the old asset to use the new filename\n` +
              `  Path rules after placing (MUST follow — preview runs at non-root base URL):\n` +
              `  • CORRECT: <img src={\`\${import.meta.env.BASE_URL}assets/${safeName}\`} />\n` +
              `  • WRONG:   <img src="/assets/${safeName}" />  (404 in preview)\n` +
              `  • WRONG:   any hardcoded http:// or localhost URL\n` +
              `  Always use import.meta.env.BASE_URL (no leading slash on the filename part).${oldAssetsNote}`
            );
          }
        } catch (copyErr: any) {
          parts.push(`- **Image**: "${att.name}" — failed to process: ${copyErr.message}`);
        }
      } else if (TEXT_TYPES.has(att.type)) {
        // Inline text content so the AI can read it
        try {
          let text = await fs.promises.readFile(resolvedPath, 'utf8');
          if (text.length > 30_000) text = text.slice(0, 30_000) + '\n\n… (truncated)';
          parts.push(
            `- **Document**: "${att.name}" (${att.type})\n\n\`\`\`\n${text}\n\`\`\``
          );
        } catch (readErr: any) {
          parts.push(`- **Document**: "${att.name}" — failed to read: ${readErr.message}`);
        }
      } else {
        // Binary docs (PDF, DOCX, XLSX) — try to extract text for the AI, also copy into project
        try {
          const assetsDir = path.join(appPath, 'public', 'assets');
          await fs.promises.mkdir(assetsDir, { recursive: true });
          const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const destPath = path.join(assetsDir, safeName);
          await fs.promises.copyFile(resolvedPath, destPath);

          // Attempt text extraction for document types the AI can reason about
          if (EXTRACTABLE_DOC_TYPES.has(att.type)) {
            const extractedText = await extractDocumentText(resolvedPath, att.type);
            if (extractedText) {
              let text = extractedText;
              if (text.length > 30_000) text = text.slice(0, 30_000) + '\n\n… (truncated)';
              parts.push(
                `- **Document**: "${att.name}" (${att.type}) → copied to \`public/assets/${safeName}\`\n  Also available as downloadable file at \`\${import.meta.env.BASE_URL}assets/${safeName}\`. NEVER use \`/assets/${safeName}\` with a leading slash — the preview uses a non-root base URL.\n\n  **Extracted Text Content:**\n\n\`\`\`\n${text}\n\`\`\``
              );
            } else {
              parts.push(
                `- **Document**: "${att.name}" (${att.type}) → copied to \`public/assets/${safeName}\`\n  This file is available in the project but text extraction failed. The user may want it linked or downloadable. Reference as \`\${import.meta.env.BASE_URL}assets/${safeName}\`. Follow their instructions.`
              );
            }
          } else {
            parts.push(
              `- **Document**: "${att.name}" (${att.type}) → copied to \`public/assets/${safeName}\`\n  This file is available in the project. The user may want it linked, downloadable, or processed. Reference as \`\${import.meta.env.BASE_URL}assets/${safeName}\`. Follow their instructions.`
            );
          }
        } catch (copyErr: any) {
          parts.push(`- **Document**: "${att.name}" — failed to copy: ${copyErr.message}`);
        }
      }
    }
    attachmentContext = `\n\n# User-Attached Files\n\nThe user attached the following files with this message.\n\n**IMPORTANT — Images are NOT yet in the project.** Each image stays in a temporary path until you explicitly call \`place_asset\` to copy it to \`public/assets/\`. You MUST call \`place_asset\` before you can reference an image in any component.\n\n**YOUR OBLIGATION:** You MUST act on these files as the user instructs. Do not just acknowledge them — actually use them in the code.\n\nCommon scenarios — execute immediately:\n- "use as logo / header logo" → call place_asset to place the image, then update the Navbar/Header component to render an \`<img>\` using it\n- "use as favicon" → call place_asset, then write to \`public/favicon.ico\` (or .png) and update \`index.html\` \`<link rel="icon">\`\n- "use as hero / banner" → call place_asset, then place in the hero section of the relevant page\n- "use as background" → call place_asset, then apply as CSS \`background-image\` on the specified element\n- "use this data / content" → parse the document content and populate the UI with it\n- General "use this" → infer the best placement from context and the image description\n\nAlways modify the actual component files to reference the image. An image that was never placed with \`place_asset\` cannot be referenced in code.\n\n${parts.join('\n\n')}`;
    attachmentContext = clampContextSection('Attachment context', attachmentContext, MAX_ATTACHMENT_CONTEXT_CHARS);
  }

  // ── Pre-flight vision analysis ────────────────────────────────────────────
  // BEFORE the agent loop starts, ask the model to describe each uploaded image.
  // This gives the agent a concrete textual understanding of the image content
  // ("company logo with a blue shield and white text 'EcomGear'") so it can
  // decide the correct action without guessing from the filename alone.
  // Only runs when the selected model supports vision (Claude, Gemini — not DeepSeek).
  if (visionCapable && imageVisionData.length > 0) {
    const analysisParts: string[] = [];
    for (const img of imageVisionData) {
      // Skip images already described inline during attachment processing
      const preAnalysis = (img as any)._preAnalysis as string | undefined;
      if (preAnalysis) continue; // already injected into the parts[] entry above
      const analysis = await analyzeImageWithVision(
        img.base64, img.type, img.name, aiProvider, abortSignal,
      );
      analysisParts.push(`- **${img.name}**: ${analysis}`);
    }
    if (analysisParts.length > 0) {
      attachmentContext +=
        `\n\n## Visual Analysis of Attached Images\n\n` +
        `The following descriptions were obtained by visually analysing each image BEFORE you start making changes. ` +
        `Read them carefully to understand what each image actually is:\n\n` +
        analysisParts.join('\n') +
        `\n\nUse the visual analysis above to understand each image, then execute the user's request. If the user says "use this as logo" and the analysis confirms it looks like a logo, immediately call place_asset then edit the relevant component to render it.`;
    }
  }

  // Detect if this is the first build on an empty/new project.
  // Use fileSources (full relative paths like src/pages/Home.tsx) NOT liveFileTree —
  // the tree is indent-formatted so full paths like "src/pages/Home.tsx" never appear in it.
  const hasUserFiles = fileSources.some(f =>
    /^src\/pages\//.test(f.path) ||
    (/^src\/components\//.test(f.path) && !/^src\/components\/ui\//.test(f.path)) ||
    (/^src\/views\//.test(f.path)) ||
    (/^src\/screens\//.test(f.path))
  ) || fileSources.filter(f =>
    /^src\/.*\.(tsx|jsx)$/.test(f.path) && !/^src\/components\/ui\//.test(f.path)
  ).length > 3;
  const isEmptyProject = !hasUserFiles;
  const isFirstMessage = !history || history.length === 0;
  const shouldConfirmFirst = isEmptyProject && isFirstMessage && runtimeMode === 'build';

  const modeInstruction = runtimeMode === 'plan'
    ? `\n\n# Runtime Mode Instruction

You are operating in **PLAN MODE**. You are a strategic planning assistant — your role is to think, discuss, advise, and help the user design their project. You do NOT make any changes to files.

## Hard rules
- NEVER call write_file, edit_file, delete_file, or any file-modification tool.
- NEVER emit <ecomgear-write>, <ecomgear-edit>, or any operational tags.
- Do NOT produce code blocks that represent final implementation — only illustrative snippets to explain a concept.
- Do NOT emit any <ecomgear-*> tags.

## What you CAN do
- Discuss the project vision, goals, and target users.
- Suggest features, pages, components, and architecture.
- Break work into phases or milestones.
- Answer questions about technology choices, best practices, UX patterns.
- Help the user refine requirements and spot gaps or conflicts.
- Produce structured plans, site maps, or feature lists when helpful.
- Be concise — bullet points over paragraphs where possible.

## If the user asks you to make changes or implement something
Respond briefly. Acknowledge what they want, then say:
> "I'm in **Plan mode** — I can only plan and advise here. Switch to **Build mode** to implement this."
Keep that redirect to one or two sentences. Do not lecture or repeat it.

## Tone
Conversational, sharp, helpful. Think of yourself as a senior technical co-founder reviewing the project with the user — not a code generator. Stay focused on what the user is asking.`
    : shouldConfirmFirst
    ? '\n\n# Runtime Mode Instruction\n\nMode: BUILD (confirm-first). This is a NEW empty project — the user\'s first request.\n\n' +
      'IMPORTANT EXCEPTION: If the user\'s message is a simple greeting ("hi", "hello", "hey", etc.), general chat, or does NOT describe what they want to build, respond with a friendly welcome and ask what they\'d like to build. Do NOT invent or assume a project idea. Do NOT call any tools.\n\n' +
      'MANDATORY FLOW (only when the user describes what they want to build):\n' +
      '1. Call `think` to plan the full architecture.\n' +
      '2. Present a concise spec to the user (follow the "First Build" section in Requirement Gathering).\n' +
      '3. Do NOT write any files yet. Do NOT call write_file, edit_file, or any file-modification tools.\n' +
      '4. End by asking the user to confirm or adjust the plan.\n' +
      '5. When the user confirms in the NEXT message, you will receive BUILD mode and should execute immediately.'
    : '\n\n# Runtime Mode Instruction\n\nMode is locked to BUILD by backend policy. Do not self-switch modes.\n\nHard requirements:\n- Execute now: use tools and produce real file changes immediately.\n- Do NOT ask for confirmation to start coding (unless the user\'s intent is genuinely unclear — see EXCEPTION below).\n- Do NOT end with planning-only instructions.\n- PHASED BUILD: If the conversation history contains a phase plan (look for "## Phases" and "Phase N —" lines), you are in phased build mode. Count how many "Phase N done ✓" messages already appear in the history to determine which phase is current. Build ONLY the files for that phase — do NOT build files from future phases. When all files for the current phase are written and verified, end your final message with exactly: "Phase N done ✓ — ready to build Phase N+1 ([one-line description])? Reply **continue** to proceed." If this is the last phase, write instead: "All phases complete ✓ — your app is ready." IMPORTANT: In phased mode the rule below about writing ALL files is scoped to the current phase only.\n- NON-PHASED BUILD: You MUST write ALL files the app needs before finishing — pages, components, utilities, AND src/App.tsx. Never stop after writing just a few files. A partial build = broken preview.\n- STRICTLY FORBIDDEN: Never say "I didn\'t make any changes", "I haven\'t changed anything", "no changes were made", or any equivalent. If you ran without writing files, you failed — do not announce it, just start writing.\n- ALSO FORBIDDEN: Never output a future-tense promise like "Let me do this", "I\'ll implement that", "I will go ahead and", "I\'m going to build" unless you IMMEDIATELY follow it with actual file writes in the same response. If you say it and then stop with no files written — that is a failure. Either write files right away or ask what the user wants.\n- EXCEPTION (greetings only): If the user\'s message is EXCLUSIVELY a greeting ("hi", "hello", "hey", "how are you") or an identity question ("who are you", "what are you") with NO build request attached — respond with a short text answer only and do NOT call tools. This exception does NOT apply to any message that contains a feature request, a page name, a description, a confirmation ("ok", "yes", "go", "proceed", "build it", "do it"), or ANY reference to the project.\n- EXCEPTION (ambiguous statement): If the user\'s message is a vague statement with NO specific build content (no feature name, page, component, or change described) AND you cannot identify a pending plan in the conversation history to execute — ask ONE short clarifying question about what they\'d like you to build or change. Do NOT invent a task. Do NOT write files for a made-up goal.\n- If the user confirmed a plan you already presented (e.g. "ok", "yes", "go ahead", "looks good", "build it") — that IS a build command. Execute immediately.\n- BRAIN MEMORY: Your older tool call history is automatically compacted to save tokens. Use `save_memory` after your initial `think` to persist key architecture decisions, file purposes, and user requirements so they survive compaction.';

  // Efficiency instruction — scope it to the tier so micro/fix stay fast but edit
  // still verifies imports (skipping that check is the #1 source of build errors).
  // In plan mode, tier instructions must be suppressed — they reference file-modification
  // workflows (touch, read, write) that contradict plan-mode restrictions.
  const tierInstruction = runtimeMode === 'plan' ? ''
    : _tier === 'micro'
      ? '\n\n# Efficiency Mode\nDo NOT write any text before your first tool call. Call `think` once (≤40 words), read the file, make the change, done.\n\n**REQUIRED final message** — write exactly this format:\n"I\'ve [verb] [what] in [filename]. [One sentence on what the user will now see.]"\nExample: "I\'ve changed the button color to indigo in Header.tsx. The nav bar buttons now match the brand palette."\nFORBIDDEN: "Done.", "OK.", empty message, or any single-word reply.'
      : _tier === 'fix'
        ? '\n\n# Fix Mode\nDo NOT write any text before your first tool call. Start with tools directly. Call `think` once — identify root cause, read the broken file, fix it, verify with `get_build_errors`.\n\n**Progress narration** — after each file you fix, write one short sentence like "Fixed the import error in Navbar.tsx — now checking the build." before moving to the next file.\n\n**REQUIRED final message** — AT LEAST 2 sentences:\n1. What the error was and which file it was in.\n2. What you changed to fix it.\nFORBIDDEN: "Done.", "Fixed.", "OK.", or any single-word reply.'
        : _tier === 'edit'
          ? '\n\n# Edit Mode\nDo NOT write any text before your first tool call. Start with tool calls directly. Call `think` once — list the 1–3 files you will touch.\n\n**Progress narration (REQUIRED)** — after each file you write or edit, output one short sentence telling the user what you just did and what you\'re doing next. Examples:\n- "Updated the Navbar — now working on the hero section."\n- "Added the cart drawer to CartDrawer.tsx — updating the context next."\nThis keeps the user informed while you work.\n\n**HARD FILE LIMIT** — more than 5 files? STOP after the 5th, tell the user what changed and what remains.\n\n**REQUIRED final message** — AT LEAST 2 sentences: what changed and what the user will see differently.\nFORBIDDEN: "Done.", "OK.", any single word, or any message under 15 words.'
          : '\n\nDo NOT write any text before your first tool call. Start with tool calls directly.\n\n**Progress narration (REQUIRED)** — after each file you write or create, output one short sentence telling the user what you just did and what comes next. Keep it brief and specific. Examples:\n- "Built the Navbar with sticky positioning and a cart icon — now creating the hero banner."\n- "Added HeroBanner.tsx with a full-width gradient — moving on to the categories section."\n- "Categories grid done — now wiring up the product cards."\nThis narration shows the user the build is progressing in real time.\n\n**REQUIRED final message** — AT LEAST 3 sentences after ALL changes:\n1. What you built and in which files.\n2. How the feature works from the user\'s perspective.\n3. Any important decisions the user should know.\nFORBIDDEN: "Done.", "Complete.", or any response under 20 words.';

  const boundedFileTree = clampContextSection('Project file tree', liveFileTree, MAX_FILE_TREE_CHARS);

  const promptProfile = runtimeMode === 'plan'
    ? 'plan'
    : shouldConfirmFirst
      ? 'confirm'
      : isLikelyFixRequest(prompt)
        ? 'fix'
        : 'build';

  // Tier-based prompt selection (smallest prompt that can handle the task):
  //   micro  →  ~600 tokens   (color/text/spacing tweaks)
  //   fix    →  ~3K tokens    (error fixes — no design/new-project sections)
  //   edit   →  ~4K tokens    (changes to existing apps — strips registry/chunking/new-project)
  //   build  →  ~6-10K tokens (new projects / features — context-stripped build prompt)
  //   other  →  full prompt   (plan/confirm profiles)
  // Plan mode must never receive tier-specific build/edit/fix prompts — they contain
  // file-write instructions that directly conflict with plan-mode restrictions.
  const staticSystemPrompt = runtimeMode === 'plan'
    ? getAppBuilderSystemPrompt('plan')
    : _tier === 'micro'
      ? MICRO_SYSTEM_PROMPT
      : _tier === 'fix'
        ? getFixSystemPrompt()
        : _tier === 'edit' && !isEmptyProject
          ? getEditSystemPrompt()
          : promptProfile === 'build'
            ? getAppBuilderBuildSystemPrompt({
                includeRequirementGathering: isEmptyProject,
                includeStartingNewProject: isEmptyProject,
                includeSeo: promptIntent?.isWebsiteBuild === true,
                includeIntegration: promptIntent?.hasIntegrationRequest === true,
                includeErrorPatterns: isEmptyProject,
                includeCapabilities: isEmptyProject,
                includePreviewEnvironment: isEmptyProject,
              })
            : getAppBuilderSystemPrompt(promptProfile);

  console.log(
    `[AgentLoop] Prompt profile=${promptProfile} tier=${_tier ?? 'unset'} maxSteps=${MAX_STEPS} staticChars=${staticSystemPrompt.length} ` +
    `website=${promptIntent?.isWebsiteBuild === true} integration=${promptIntent?.hasIntegrationRequest === true} emptyProject=${isEmptyProject}`
  );

  // Build the project knowledge block from KnowledgeSettings (custom_system_prompt + context_notes).
  // This is injected at the top of every request so the agent always has project-specific context.
  const knowledgeBlock = (() => {
    const parts: string[] = [];
    if (projectKnowledge?.customSystemPrompt) {
      parts.push(`## Custom Instructions\n\n${projectKnowledge.customSystemPrompt}`);
    }
    if (projectKnowledge?.contextNotes) {
      parts.push(`## Project Context Notes\n\n${projectKnowledge.contextNotes}`);
    }
    return parts.length > 0
      ? `\n\n# Project Knowledge\n\nThe project owner has set the following custom instructions and context. Follow them throughout this entire session — they take precedence over default behavior.\n\n${parts.join('\n\n')}`
      : '';
  })();

  // Inject project secrets as env var context — agent may reference them in code
  // but MUST NEVER echo, print, log, or reveal their values in chat responses.
  const secretsBlock = (() => {
    if (!projectSecrets || projectSecrets.length === 0) return '';
    const lines = projectSecrets.map(s => `${s.key_name}=${s.key_value}`).join('\n');
    const hasSb  = projectSecrets.some(s => s.key_name === 'VITE_SUPABASE_URL');
    const hasDb  = projectSecrets.some(s => s.key_name === 'VITE_DB_API_URL');
    const hasEcg = projectSecrets.some(s => s.key_name === 'ECG_PORTAL_TOKEN');
    const hasEcgMcp = projectSecrets.some(s => s.key_name === 'ECG_MCP_URL');

    const sbNote = hasSb
      ? '\n\nFor Supabase auth/data in generated code ALWAYS use `import.meta.env.VITE_SUPABASE_URL` and `import.meta.env.VITE_SUPABASE_ANON_KEY`. NEVER hardcode any `*.supabase.co` URL — it will cause CORS errors in the preview.'
      : '';
    const dbNote = hasDb
      ? '\n\nFor the hosted database use PostgREST calls to `import.meta.env.VITE_DB_API_URL/rest/v1/<table>` with headers `{ "Authorization": "Bearer <VITE_DB_ANON_KEY>", "apikey": "<VITE_DB_ANON_KEY>", "Accept-Profile": "<VITE_DB_SCHEMA>", "Content-Profile": "<VITE_DB_SCHEMA>" }`. Accept-Profile/Content-Profile are REQUIRED — without them PostgREST routes to its default schema instead of this project\'s isolated one and every request 403s. Call `get_database_schema` to inspect tables, `query_database` to run SQL.'
      : '';
    const ecgNote = hasEcg
      ? '\n\n## eCG Agents Portal Integration\n\nThis project is linked to the eCG Agents Portal. Follow these rules strictly:\n\n**Frontend (React) code** — NEVER call the portal API directly from the browser. All portal data goes through the eComGear server proxy:\n```ts\n// In src/lib/ecgClient.ts — already configured\nconst url = `${import.meta.env.VITE_ECG_PROXY_URL}/api/v1/ecg-proxy${path}?projectId=${import.meta.env.VITE_PROJECT_ID}`;\n```\nUse `ecgApi` from `src/lib/ecgClient.ts` for all data fetching. Do not use `ECG_PORTAL_TOKEN` — it is server-side only.\n\n**Edge functions** — use the pre-injected `ecg` helper (not `fetch`). ECG credentials are injected server-side:\n```js\n// Agents\nconst agents = await ecg.get(\'/agents\');\n// Approve a post\nawait ecg.patch(\'/planned-posts/\' + params.postId, { status: \'approved\' });\n// Run history\nconst runs = await ecg.get(\'/runs\');\n// LLM call (uses the configured AI model, key stays server-side)\nconst reply = await ecg.llm([\n  { role: \'user\', content: \'Summarize agent performance\' }\n], \'You are an eCG assistant.\');\n```\n`ecg` is `null` for projects without portal integration — check before using.\n\n**AI chat** — the dashboard has a built-in `AiAssistantPage.tsx` that calls `/api/v1/ecg-proxy/ai-chat`. Extend it, do not duplicate it.\n\n**Security rule** — NEVER expose `ECG_PORTAL_TOKEN`, `ECG_LLM_API_KEY`, or any `ECG_*` secret in frontend code, logs, or responses.' +
        (hasEcgMcp ? '\n\n**Knowledge base** — you have a `search_org_knowledge` tool. Use it to ground generated UI copy and content (brand voice, product descriptions, business context) in the organization\'s real knowledge instead of inventing generic placeholder text.' : '')
      : '';

    return `\n\n# Project Environment Variables\n\nThe following secrets are available as \`import.meta.env.VITE_XXX\` (frontend) or \`process.env.XXX\` (backend). NEVER echo, print, log, or reveal their values in chat responses — treat them as confidential.${sbNote}${dbNote}${ecgNote}\n\n\`\`\`\n${lines}\n\`\`\``;
  })();

  // micro: no modeInstruction (MICRO_SYSTEM_PROMPT already embeds directives)
  // edit: compact instruction — no phased build, no verbose rules (saves ~1,500 tokens)
  // plan mode always wins — tier instructions must never override plan-mode restrictions
  const EDIT_MODE_INSTRUCTION = '\n\n# Runtime Mode Instruction\nExecute immediately — start with tool calls directly. Do NOT write any text before your first tool call. No "I\'ll...", no "Let me...", no acknowledgments before tools. Do NOT ask for confirmation. Do NOT rewrite files not involved in the change. If intent is unclear, ask one short question before calling tools.\n\n**Progress narration (REQUIRED)** — after each file you edit or create, write one short sentence telling the user what you just changed and what you\'re doing next. Example: "Updated the header in Navbar.tsx — now fixing the color in HeroBanner.tsx." This keeps the user informed while you work.\n\n**REQUIRED final message** — once all changes are done, write AT LEAST 2 full sentences. Start with "I\'ve [verb]..." and name the files and exact changes. Then explain what the user will see differently. FORBIDDEN: "Done.", "OK.", "Updated.", any single word, or any message shorter than 15 words.';
  const effectiveModeInstruction = runtimeMode === 'plan' ? modeInstruction
    : _tier === 'micro' ? ''
    : _tier === 'edit' ? EDIT_MODE_INSTRUCTION
    : modeInstruction;

  // micro tier: only send the directly-mentioned file, not up to 4 files.
  // A colour/text change only needs the one file that contains the element.
  const effectiveFilesContext = _tier === 'micro'
    ? (cappedFiles.find(f => directlyMentioned.has(f.path))
        ? `=== ${cappedFiles.find(f => directlyMentioned.has(f.path))!.path} ===\n${cappedFiles.find(f => directlyMentioned.has(f.path))!.contextContent}`
        : existingFilesContext.split('\n\n')[0] ?? '')  // just first file if none mentioned
    : existingFilesContext;

  const assemblePrompt = (base: string) =>
    base +
    knowledgeBlock +
    secretsBlock +
    effectiveModeInstruction +
    tierInstruction +
    (boundedOlderSummary
      ? `\n\n# Earlier Conversation Summary\n\nThis is a summary of older messages in this conversation. Use it to maintain continuity:\n\n${boundedOlderSummary}`
      : '') +
    (boundedFileTree
      ? `\n\n# Project File Tree\n\nThese are ALL the files currently on disk. This is authoritative — if a file is not listed here, it does NOT exist. Use this to verify imports and plan which files to create or edit.\n\n\`\`\`\n${boundedFileTree}\n\`\`\``
      : '\n\n# Project File Tree\n\nThe project directory is empty — this is a fresh project. You must create all files from scratch.') +
    (effectiveFilesContext
      ? `\n\n# Current Project File Contents\n\nFocused previews of the most relevant project files. Use these to get oriented quickly, then call \`read_file\` for any file you need in full before editing.\n\n${effectiveFilesContext}${_tier !== 'micro' ? truncatedFilesNote + excludedFilesNote : ''}`
      : '') +
    attachmentContext;

  // Defense-in-depth: strip any build-mode directives that should never appear in plan mode.
  // This catches any future instruction block that forgets to check runtimeMode first.
  const enforcePlanMode = (prompt: string): string => {
    if (runtimeMode !== 'plan') return prompt;
    return prompt
      .replace(/Execute immediately[^.]*\./gi, '')
      .replace(/Mode is locked to BUILD[^\n]*/gi, '')
      .replace(/# Efficiency Mode[\s\S]*?(?=\n#|\n\n#|$)/g, '')
      .replace(/# Edit Mode[\s\S]*?(?=\n#|\n\n#|$)/g, '')
      .replace(/# Fix Mode[\s\S]*?(?=\n#|\n\n#|$)/g, '');
  };

  const systemPrompt = enforcePlanMode(assemblePrompt(staticSystemPrompt));
  const dynamicContext = enforcePlanMode(assemblePrompt(''));

  // Per-run brain memory — survives context compaction across steps.
  // Hoisted above the Gemini cache block because buildToolSet needs it.
  const brainMemory: string[] = [];
  const toolSet = runtimeMode === 'plan' ? undefined : buildToolSet(ctx, brainMemory);

  // ── Gemini run-level context cache ───────────────────────────────────────
  // Plan mode has no tools — cache just the system prompt (createGeminiRunCache).
  // Build/edit/fix/feature modes have tools — Gemini rejects generateContent
  // requests that pass tools alongside cachedContent, so those must be baked
  // into the cache itself (createGeminiToolCache). The stripToolsForCache
  // middleware then removes `tools` from the outbound wire request while
  // leaving local tool-call execution (via the `tools` object passed to
  // streamText) completely unaffected.
  let geminiRunCacheName: string | null = null;
  // DISABLED (production incident): Gemini's cachedContent API rejects ANY
  // generateContent request that also sets system_instruction, tools, OR
  // tool_config. The AI SDK's `system` param always becomes system_instruction
  // when non-empty — so there is no way to send per-request dynamic context
  // (file tree, project files) through `system` while a tool-cache is active.
  // Sending dynamicContext via `system` (as the previous fix attempted) hit
  // this exact 400 in production. Reusing a cache correctly requires routing
  // dynamic content through `messages` instead of `system`, which is a real
  // rework, not a hotfix — disabling the tool-cache path entirely until that
  // lands. Plan mode is unaffected (never sends tools, so no conflict there).
  const geminiToolCacheName: string | null = null;
  if (providerName === 'gemini' && runtimeMode === 'plan') {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      geminiRunCacheName = await createGeminiRunCache(systemPrompt, modelId, geminiKey);
    }
  }
  // Wrap the provider so the outbound request omits `tools`/`toolConfig`
  // whenever a tool cache is active — only affects the wire request, not
  // local tool-call dispatch (streamText still receives `tools: toolSet` below).
  const streamingProvider = geminiToolCacheName
    ? wrapLanguageModel({ model: aiProvider, middleware: createStripToolsForCacheMiddleware() })
    : aiProvider;

  const isAnthropicModel = providerName === 'anthropic';
  const systemMessages: Array<{ role: 'system'; content: string; providerOptions?: Record<string, any> }> = isAnthropicModel
    ? [
        // Static part — cached by Anthropic (identical across all requests)
        {
          role: 'system' as const,
          content: staticSystemPrompt,
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        // Dynamic part — changes per request (file tree, project files, attachments)
        // Also cached: it's stable across all steps of this run, so subsequent steps are cache hits.
        ...(dynamicContext.trim() ? [{ role: 'system' as const, content: dynamicContext, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }] : []),
      ]
    : geminiRunCacheName
      ? [] // plan mode: the FULL system prompt lives in the cache — sending it again would conflict
      : [{ role: 'system' as const, content: systemPrompt }];

  // Signal SSE stream start
  sseWrite(res, 'start', { projectId, model: modelId, mode: runtimeMode });

  // Use a real default timeout so upstream stalls do not leave the frontend
  // waiting indefinitely. Anthropic gets a shorter cutoff because it is the
  // provider currently most prone to long rate-limit stalls.
  const parsedAgentTimeoutMs = parseInt(process.env.AGENT_TIMEOUT_MS || '0', 10);
  const AGENT_TIMEOUT_MS = Number.isFinite(parsedAgentTimeoutMs) && parsedAgentTimeoutMs > 0
    ? parsedAgentTimeoutMs
    : getDefaultAgentTimeoutMs(providerName);
  const abortController = new AbortController();
  const externalAbortHandler = () => abortController.abort();

  if (abortSignal) {
    if (abortSignal.aborted) {
      abortController.abort();
    } else {
      abortSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  // Set to true when the timeout handler already emitted a 'done' event.
  // Prevents the route-level catch from emitting a second 'error' SSE after abort.
  let timeoutDoneSent = false;

  const agentTimeoutId = AGENT_TIMEOUT_MS > 0 ? setTimeout(async () => {
    if (abortController.signal.aborted) return;
    console.warn(`[AgentLoop] Timeout hit after ${AGENT_TIMEOUT_MS}ms — salvaging files before aborting`);

    try {
      const SKIP_DIRS_TIMEOUT = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.tmp', 'coverage']);
      const SKIP_FILES_TIMEOUT = new Set(['package-lock.json', '.ecomgear-hash', '.DS_Store', '.env', '.env.local', '.env.production', '.gitignore']);
      const BINARY_EXTS_TIMEOUT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.webp', '.mp4', '.mp3', '.pdf', '.zip']);
      const BIN_SENTINEL = '__ECOMGEAR_BIN64__';

      const salvageMap = new Map<string, string>();
      const salvageCollect = (dir: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (SKIP_DIRS_TIMEOUT.has(entry.name)) continue;
          if (SKIP_FILES_TIMEOUT.has(entry.name)) continue;
          const fp = path.join(dir, entry.name);
          if (entry.isDirectory()) { salvageCollect(fp); }
          else {
            const ext = path.extname(entry.name).toLowerCase();
            const rel = path.relative(appPath, fp);
            try {
              if (BINARY_EXTS_TIMEOUT.has(ext)) {
                salvageMap.set(rel, `${BIN_SENTINEL}${fs.readFileSync(fp).toString('base64')}`);
              } else {
                salvageMap.set(rel, fs.readFileSync(fp, 'utf8'));
              }
            } catch { /* skip */ }
          }
        }
      };
      salvageCollect(appPath);

      if (salvageMap.size > 0) {
        const salvageFiles = Array.from(salvageMap.entries()).map(([p, c]) => ({ path: p, content: c }));
        sseWrite(res, 'done', {
          filesToWrite: runtimeMode === 'plan' ? [] : salvageFiles,
          filesToDelete: [],
          renames: [],
          dependencies: [],
          mode: runtimeMode,
          summary: 'Agent timed out. Partial progress was saved.',
          tokensUsed: 0,
          snapshotId: `${projectId}_${randomUUID().replace(/-/g, '')}`,
        });
        timeoutDoneSent = true;
      }
    } catch (salvageErr) {
      console.warn('[AgentLoop] File salvage on timeout failed:', salvageErr);
    }

    // Mark the abort so the catch block knows not to emit a second 'error' SSE.
    const timeoutAbortErr = Object.assign(new Error('Agent timeout'), { isAgentTimeout: true });
    abortController.abort(timeoutAbortErr);
  }, AGENT_TIMEOUT_MS) : null;

  // Heartbeat: keep SSE connection alive and let the frontend detect dead connections.
  const HEARTBEAT_INTERVAL_MS = 15_000;
  const heartbeatId = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
    }
  }, HEARTBEAT_INTERVAL_MS);

  try {
    let accumulatedText = '';
    let emittedStabilityNotice = false;

    const sanitizeUserFacingDelta = (text: string): string => {
      // Keep raw model output for parsing, but avoid surfacing raw compiler logs to end users.
      const looksLikeBuildLog = /\[plugin:vite|\bpostcss\b|\berror\s+TS\d+\b|\/(src|var)\/[^\n]+:\d+:\d+|^\s*at\s+[^\n]+\([^\n]+\)$/im.test(text);
      if (!looksLikeBuildLog) return text;
      if (SUPPRESS_RECOVERY_UI) return '';
      if (emittedStabilityNotice) return '';
      emittedStabilityNotice = true;
      return '\n> *Running automatic stability checks and fixes...*\n\n';
    };
    let streamError: any = null;

    // Only snapshot in build mode — plan mode never touches files so there's nothing to restore.
    const snapshotId = runtimeMode !== 'plan' ? `${projectId}_${randomUUID().replace(/-/g, '')}` : null;
    const snapshotDir = snapshotId ? path.join(SNAPSHOTS_DIR, snapshotId) : null;
    if (snapshotDir) {
      snapshotProject(appPath, snapshotDir).catch(() => {});
    }

    let currentUserContent: any = boundedPrompt;
    if (visionCapable && imageVisionData.length > 0) {
      const contentParts: any[] = imageVisionData.map(img => ({
        type: 'image',
        image: img.base64,
        mimeType: img.type,
      }));
      contentParts.push({ type: 'text', text: boundedPrompt });
      currentUserContent = contentParts;
    }

    let conversationMessages: Array<{ role: 'user' | 'assistant'; content: any; providerOptions?: any }> = [
      ...(history ?? []),
      { role: 'user', content: currentUserContent },
    ];

    // For Anthropic: mark the last history message as a cache breakpoint so the entire
    // prior conversation is served from cache on each subsequent step. Cached input tokens
    // count at ~10% toward the rate limit, reducing 429s on the 30k TPM org tier.
    if (isAnthropicModel && history && history.length > 0) {
      const lastHistoryIdx = history.length - 1;
      conversationMessages = [
        ...conversationMessages.slice(0, lastHistoryIdx),
        { ...conversationMessages[lastHistoryIdx], providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
        ...conversationMessages.slice(history.length),
      ];
    }

    const MAX_RETRIES = 2;
    let lastStreamError: any = null;

    const attemptStream = async (provider: any, attempt: number, pName = providerName): Promise<ReturnType<typeof streamText>> => {
      // DeepSeek caps max_tokens at 8192; other providers can handle 16384+
      const outputLimit = pName === 'deepseek' ? 8192 : 16384;
      return streamText({
        model: provider,
        system: systemMessages,
        messages: conversationMessages,
        ...(toolSet ? { tools: toolSet } : {}),
        ...((geminiRunCacheName || geminiToolCacheName) && pName === 'gemini'
          ? { providerOptions: { google: { cachedContent: (geminiRunCacheName || geminiToolCacheName) as string } } }
          : {}),
        maxOutputTokens: outputLimit,
        maxRetries: 0, // We handle retries + fallback ourselves
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: abortController.signal,
        // ─── Context window management ─────────────────────────────────
        // Before each step, compact older messages and inject the run's
        // Change Journal so the agent always knows what it has done this run,
        // even after tool-call history is compacted.
        prepareStep: async ({ stepNumber, messages }) => {
          runLedger.setStep(stepNumber);
          const compacted = compactStepMessages(messages, stepNumber, brainMemory);
          const journalBlock = runLedger.buildJournalBlock();

          // When running low on steps, inject a CRITICAL reminder to finish App.tsx and pages.
          // Fires when 5 steps remain (min 3 so it always fires even for small budgets).
          const LOW_STEPS_THRESHOLD = Math.max(3, MAX_STEPS - 5);
          const shouldWarnLowSteps = stepNumber === LOW_STEPS_THRESHOLD;
          const stepsLeft = MAX_STEPS - stepNumber;
          const lowStepsWarning = shouldWarnLowSteps
            ? `\n\n⚠️ STEP BUDGET WARNING: You have ${stepsLeft} steps remaining (used ${stepNumber}/${MAX_STEPS}).\n\nIMMEDIATE PRIORITY — check the file tree right now:\n1. If src/App.tsx is still the Welcome stub → write all missing page files THEN write src/App.tsx IMMEDIATELY. Do NOT write more utility or component files first.\n2. If pages exist but App.tsx is missing routes → fix App.tsx NOW.\n3. If App.tsx is complete → continue normal work.\n\nDo NOT let the step limit expire without writing a proper src/App.tsx. A partial build = broken preview.`
            : '';

          if (journalBlock || lowStepsWarning) {
            const base = compacted !== messages ? compacted : [...messages];
            // Append at the very end rather than splicing into the middle of the
            // conversation. The journal changes every step (it embeds the step
            // counter), so splicing it mid-history broke the Anthropic/Gemini
            // prompt-cache prefix on every step — the model re-paid full price
            // for the entire conversation instead of getting a cache hit on
            // everything before this step. Appending keeps that whole prefix
            // byte-identical across steps; only this trailing message is new.
            const injectedContent = [journalBlock, lowStepsWarning].filter(Boolean).join('\n\n');
            const withInjected = [
              ...base,
              { role: 'user' as const, content: injectedContent },
            ];
            return { messages: withInjected };
          }

          if (compacted !== messages) {
            return { messages: compacted };
          }
          return {};
        },
        onStepFinish: ({ text, toolCalls, toolResults, usage, experimental_providerMetadata }: any) => {
          stepCount++;
          runLedger.setStep(stepCount);
          const toolNames = (toolCalls ?? []).map((tc: any) => tc.toolName);
          const failedEdits = (toolResults ?? [])
            .filter((tr: any) => typeof tr?.result === 'string' && tr.result.startsWith('Error'))
            .length;

          // ── Token accounting for this step ────────────────────────────
          const stepInp    = (usage?.promptTokens     ?? usage?.inputTokens     ?? 0) as number;
          const stepOut    = (usage?.completionTokens ?? usage?.outputTokens    ?? 0) as number;
          const anthMeta   = experimental_providerMetadata?.anthropic?.usage ?? (experimental_providerMetadata as any)?.usage ?? {};
          const stepCacheR = (anthMeta.cacheReadInputTokens    ?? 0) as number;
          const stepCacheW = (anthMeta.cacheCreationInputTokens ?? 0) as number;

          runTokens.inputTokens      += stepInp;
          runTokens.outputTokens     += stepOut;
          runTokens.cacheReadTokens  += stepCacheR;
          runTokens.cacheWriteTokens += stepCacheW;

          const stepCost    = calcCost(stepInp, stepOut, stepCacheR, stepCacheW);
          const runCost     = calcCost(runTokens.inputTokens, runTokens.outputTokens, runTokens.cacheReadTokens, runTokens.cacheWriteTokens);

          // Derive a human-readable status from this step's tool calls so the
          // user sees contextual progress rather than raw file paths.
          const stepStatus = deriveStepStatus(toolCalls ?? [], toolResults ?? []);

          sseWrite(res, 'step-finish', {
            step: stepCount,
            hasText: !!text,
            toolCount: toolNames.length,
            tools: toolNames,
            failedEdits,
            ...(stepStatus ? { status: stepStatus } : {}),
            tokens: {
              step:  { input: stepInp, output: stepOut, cacheRead: stepCacheR, cacheWrite: stepCacheW, total: stepInp + stepOut + stepCacheR + stepCacheW },
              run:   { input: runTokens.inputTokens, output: runTokens.outputTokens, cacheRead: runTokens.cacheReadTokens, cacheWrite: runTokens.cacheWriteTokens, total: runTokens.total },
              stepCostUsd: parseFloat(stepCost.toFixed(5)),
              runCostUsd:  parseFloat(runCost.toFixed(5)),
            },
          });

          console.log(
            `[AgentLoop] Step ${stepCount} | tools: ${toolNames.join(', ') || 'none'}` +
            `${failedEdits > 0 ? ` (${failedEdits} failed)` : ''}` +
            ` | tokens: in=${stepInp} out=${stepOut} cacheR=${stepCacheR} cacheW=${stepCacheW}` +
            ` | step $${stepCost.toFixed(5)} | run total $${runCost.toFixed(4)}` +
            (userId ? ` | user=${userId}` : ''),
          );

          // ── Per-run hard caps ────────────────────────────────────────────
          // Two gates: token count + dollar cost. Whichever fires first aborts the run.
          // Token cap is tier-based (RUN_TOKEN_CAP) so build gets more headroom than micro.
          // Cost cap is a hard ceiling regardless of tier.
          const HARD_COST_CAP = parseFloat(process.env.AGENT_COST_CAP_USD || '1.50');
          if (runTokens.total > RUN_TOKEN_CAP || runCost > HARD_COST_CAP) {
            const reason = runCost > HARD_COST_CAP
              ? `cost cap $${HARD_COST_CAP} hit ($${runCost.toFixed(3)} spent)`
              : `token cap ${RUN_TOKEN_CAP} hit (${runTokens.total} used)`;
            console.warn(`[AgentLoop] Run aborted — ${reason} (user=${userId ?? 'unknown'})`);
            sseWrite(res, 'step-finish', { step: stepCount, toolCount: 0, tools: [], status: 'Wrapping up — run budget reached.' });
            abortController.abort();
          }
        },
      });
    };

    const consumeResultStream = async (stream: ReturnType<typeof streamText>): Promise<{ text: string; err: any | null }> => {
      let textBuffer = '';
      let partError: any = null;
      let lastFinishReason: string | undefined;
      try {
        for await (const part of stream.fullStream) {
          if (part.type === 'text-delta') {
            textBuffer += part.text;
            const safeText = sanitizeUserFacingDelta(part.text);
            if (safeText) {
              sseWrite(res, 'text-delta', { text: safeText });
            }
          } else if (part.type === 'finish') {
            lastFinishReason = (part as any).finishReason;
            outerFinishReason = lastFinishReason;
            // Final overall finish — log cumulative run totals (onStepFinish already
            // captured per-step detail; this is the authoritative end-of-run summary).
            const u    = (part as any).usage;
            const meta = (part as any).providerMetadata?.anthropic?.usage ?? {};
            // Prefer values accumulated in runTokens (most complete); fall back to stream finish.
            const totalIn  = runTokens.inputTokens      || (u?.promptTokens     ?? u?.inputTokens     ?? 0);
            const totalOut = runTokens.outputTokens     || (u?.completionTokens ?? u?.outputTokens    ?? 0);
            const totalCR  = runTokens.cacheReadTokens  || (meta.cacheReadInputTokens    ?? 0);
            const totalCW  = runTokens.cacheWriteTokens || (meta.cacheCreationInputTokens ?? 0);
            const totalCost = calcCost(totalIn, totalOut, totalCR, totalCW);
            console.log(
              `[AgentLoop] RUN COMPLETE` +
              ` | input=${totalIn} output=${totalOut} cacheRead=${totalCR} cacheWrite=${totalCW}` +
              ` | total tokens=${totalIn + totalOut + totalCR + totalCW}` +
              ` | est cost $${totalCost.toFixed(4)}` +
              ` | finishReason=${lastFinishReason ?? 'unknown'}` +
              (userId ? ` | user=${userId}` : '') +
              (agentRunId ? ` | runId=${agentRunId}` : ''),
            );
            // Warn when model produces nothing — helps diagnose Gemini empty-response issues
            if (totalOut === 0) {
              console.warn(
                `[AgentLoop] ⚠️  Model produced 0 output tokens (finishReason=${lastFinishReason ?? 'unknown'}).` +
                ` This usually means conflicting prompt instructions or a safety filter triggered.` +
                ` provider=${providerName} model=${modelId}`,
              );
            }
          } else if (part.type === 'error') {
            partError = part.error;
          }
        }
      } catch (iterErr: any) {
        // Undici throws TypeError: terminated / ECONNRESET directly from the async iterator
        // instead of emitting a part.type === 'error'. Capture it so it goes through the
        // streamError recovery path (fallback providers) rather than the outer catch.
        partError = iterErr;
      }
      return { text: textBuffer, err: partError };
    };

    let result: ReturnType<typeof streamText> | null = null;
    let outerFinishReason: string | undefined;

    // Primary model: retry with exponential backoff (skip retries for network errors)
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        result = await attemptStream(streamingProvider, attempt);
        // Test the stream by consuming the first chunk — if it throws, we catch it here
        lastStreamError = null;
        break;
      } catch (err: any) {
        lastStreamError = err;
        if (abortController.signal.aborted) throw err; // Don't retry on abort
        if (providerName === 'anthropic' && isRateLimitError(err)) {
          console.warn('[AgentLoop] Anthropic rate-limited — skipping same-provider retries and switching to fallback');
          sseWrite(res, 'step-finish', { step: 0, toolCount: 0, status: 'Claude rate-limited. Switching to backup model...' });
          break;
        }
        // Network errors (DNS, connection refused) won't resolve with retries — go straight to fallback.
        if (isNetworkError(err)) {
          console.warn(`[AgentLoop] Network error on ${providerName} — skipping retries, going to fallback: ${err?.message}`);
          break;
        }
        // Auth/billing errors (org disabled, 401, 403) won't resolve with retries — go straight to fallback.
        if (isAuthOrBillingError(err)) {
          billingFailedProviders.add(providerName);
          console.warn(`[AgentLoop] Auth/billing error on ${providerName} — circuit-breaking provider for this session: ${err?.message}`);
          break;
        }
        if (!isRetryableError(err) || attempt === MAX_RETRIES) break;
        // Rate limits (429) need longer backoff. Honor the retry-after header from Anthropic.
        // If retry-after is meaningfully long it's better to fall back than hold the UI open.
        const retryAfterMs = isRateLimitError(err) ? getRetryAfterMs(err) : null;
        if (retryAfterMs !== null && retryAfterMs > 10_000) {
          console.warn(`[AgentLoop] Rate limit: retry-after=${Math.ceil(retryAfterMs / 1000)}s — skipping retries, trying fallback providers`);
          break;
        }
        // Other retryable errors (500/529/overloaded) use shorter backoff (2s/4s/8s).
        const delay = isRateLimitError(err)
          ? (retryAfterMs ?? Math.min(3000 * Math.pow(2, attempt), 10_000)) // honor header, else 3s/6s/10s
          : Math.min(1000 * Math.pow(2, attempt), 8000);  // 1s, 2s, 4s, max 8s
        console.warn(`[AgentLoop] Retryable error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err?.message ?? err}. Retrying in ${delay}ms...`);
        // Show retry status in activity log, NOT in the chat text
        sseWrite(res, 'step-finish', { step: 0, toolCount: 0, status: `Retrying in ${Math.round(delay / 1000)}s...` });
        await new Promise<void>(r => setTimeout(r, delay));
      }
    }

    // If primary failed (retryable, network, auth/billing, or model-not-found), try fallback providers
    const isModelNotFound = (() => {
      const status = lastStreamError?.status ?? lastStreamError?.statusCode;
      const msg = [lastStreamError?.message, lastStreamError?.responseBody].filter(Boolean).join(' ').toLowerCase();
      return status === 404 || msg.includes('not found') || msg.includes('does not exist') || msg.includes('model_not_found') || msg.includes('invalid model');
    })();
    if (lastStreamError && (isRetryableError(lastStreamError) || isNetworkError(lastStreamError) || isAuthOrBillingError(lastStreamError) || isModelNotFound)) {
      // Build a prioritised list of fallback candidates. Gemini-to-Gemini fallback is
      // now allowed (different model) so a bad gemini-2.5-pro can fall to gemini-2.5-flash.
      const fallbackCandidates = buildFallbackCandidates(providerName, modelId);
      for (const fallbackModelId of fallbackCandidates) {
        const fallbackInfo = createProviderForModel(fallbackModelId);
        if (!fallbackInfo) continue;
        console.warn(`[AgentLoop] Primary provider ${providerName} failed. Falling back to ${fallbackInfo.providerName}/${fallbackModelId}`);
        // Keep fallback behavior, but optionally suppress recovery UI noise.
        if (!SUPPRESS_RECOVERY_UI) {
          sseWrite(res, 'step-finish', { step: 0, toolCount: 0, status: `Switching to fallback model...` });
        }
        try {
          result = await attemptStream(fallbackInfo.provider, 0, fallbackInfo.providerName);
          lastStreamError = null;
          break; // fallback succeeded
        } catch (fallbackErr: any) {
          console.warn(`[AgentLoop] Fallback ${fallbackInfo.providerName} also failed: ${fallbackErr?.message}`);
          lastStreamError = fallbackErr;
        }
      }
    }

    if (lastStreamError || !result) {
      const isRateLimit = isRateLimitError(lastStreamError);
      const retryAfterMs = isRateLimit ? getRetryAfterMs(lastStreamError) : null;
      let errMsg = 'Model orchestration exhausted all available providers. Please try again.';
      if (isRateLimit && retryAfterMs && retryAfterMs > 30_000) {
        const waitSec = Math.ceil(retryAfterMs / 1000);
        errMsg = `AI rate limit exceeded — too many tokens this minute. Please wait ~${waitSec} seconds and try again.`;
      } else if (lastStreamError) {
        const detail = sanitizeErrorMessage(lastStreamError);
        errMsg = `${errMsg} Last provider error: ${detail}`;
      }
      const err = new Error(errMsg);
      (err as any).sseErrorEmitted = false;
      throw err;
    }

    // Consume streaming output directly for better parity with the local agent handler.
    // This avoids relying on result.text, which can throw AI_NoOutputGeneratedError.
    const firstConsume = await consumeResultStream(result);
    accumulatedText += firstConsume.text;
    streamError = firstConsume.err;

    // Recovery path: transient transport drops can emit undici "terminated" / ECONNRESET
    // after stream start. Retry once via fallback providers before failing the run.
    if (streamError && !abortController.signal.aborted && (isNetworkError(streamError) || isAuthOrBillingError(streamError))) {
      const isBillingErr = isAuthOrBillingError(streamError);
      if (isBillingErr) billingFailedProviders.add(providerName);
      const recoveryReason = isBillingErr ? 'Billing/auth error mid-stream' : 'Stream interrupted';
      console.warn(`[AgentLoop] ${recoveryReason} (${streamError?.message ?? streamError}). Trying fallback recovery once.`);
      if (!SUPPRESS_RECOVERY_UI) {
        const statusMsg = isAuthOrBillingError(streamError)
          ? 'Provider billing issue. Switching to backup model...'
          : 'Connection interrupted. Recovering with backup model...';
        sseWrite(res, 'step-finish', { step: 0, toolCount: 0, status: statusMsg });
      }

      const recoveryCandidates = buildFallbackCandidates(providerName, modelId);

      for (const fallbackModelId of recoveryCandidates) {
        const fallbackInfo = createProviderForModel(fallbackModelId);
        if (!fallbackInfo) continue;
        try {
          const recoveredStream = await attemptStream(fallbackInfo.provider, 0, fallbackInfo.providerName);
          const recoveredConsume = await consumeResultStream(recoveredStream);
          if (!recoveredConsume.err) {
            accumulatedText += recoveredConsume.text;
            streamError = null;
            console.log(`[AgentLoop] Stream recovery succeeded via ${fallbackInfo.providerName}/${fallbackModelId}`);
            break;
          }
          streamError = recoveredConsume.err;
        } catch (recoveryErr: any) {
          streamError = recoveryErr;
          console.warn(`[AgentLoop] Recovery fallback ${fallbackInfo.providerName} failed: ${recoveryErr?.message ?? recoveryErr}`);
        }
      }
    }

    if (streamError) {
      // If the timeout handler already sent a 'done' event, suppress re-throwing so the
      // route-level catch doesn't emit a second 'error' SSE that overwrites the done result.
      if (timeoutDoneSent || (streamError as any)?.isAgentTimeout) {
        console.log('[AgentLoop] Timeout abort — swallowing streamError, done already sent.');
        return { filesToWrite: [], filesToDelete: [], renames: [], dependencies: [], summary: '' };
      }
      throw streamError;
    }

    // ─── Hallucinated-completion guard ──────────────────────────────────────
    // Some runs end with the model narrating a file change in prose ("I've
    // updated X to do Y") without ever calling write_file/edit_file, and
    // without the legacy <ecomgear-write> tag protocol either — i.e. nothing
    // was actually saved, but the text reads exactly like a real completion.
    // Detect that specific pattern and force one corrective continuation
    // (spending steps we already have budget for) instead of silently
    // finalizing on a claim that isn't backed by any tool call.
    const wroteAnythingSoFar = filesToWrite.length > 0 || filesEdited.length > 0 || filesToDelete.length > 0 || renames.length > 0;
    const hasLegacyWriteTags = /<ecomgear-(write|edit|delete|rename)\b/i.test(accumulatedText);
    const claimsCompletedEdit = /\b(i'?ve|i have)\s+(updated|changed|fixed|edited|modified|created|added|rewritten|refactored|implemented)\b/i.test(accumulatedText)
      || /\b(updated|changed|fixed|edited|modified)\s+(the\s+)?`?[\w./-]+\.(tsx?|jsx?|css|html|json)`?/i.test(accumulatedText);
    const stepsRemaining = MAX_STEPS - stepCount;

    if (runtimeMode !== 'plan' && !wroteAnythingSoFar && !hasLegacyWriteTags && claimsCompletedEdit
        && stepsRemaining >= 3 && !abortController.signal.aborted) {
      console.warn(`[AgentLoop] Hallucinated completion claim detected (zero writes, text claims a change) — forcing corrective continuation. user=${userId ?? 'unknown'}`);
      sseWrite(res, 'step-finish', { step: stepCount, toolCount: 0, tools: [], status: 'Double-checking — applying the described change...' });

      conversationMessages = [
        ...conversationMessages,
        { role: 'assistant' as const, content: accumulatedText },
        {
          role: 'user' as const,
          content: 'You just described a code change but never called write_file or edit_file — nothing was actually saved. ' +
            'If you intended to make that change, call the appropriate tool now to actually apply it. ' +
            'If you cannot or should not make the change, say so plainly instead of describing it as already done.',
        },
      ];

      try {
        const correctiveStream = await attemptStream(streamingProvider, 0, providerName);
        const correctiveConsume = await consumeResultStream(correctiveStream);
        if (!correctiveConsume.err && correctiveConsume.text) {
          accumulatedText = correctiveConsume.text;
        } else if (correctiveConsume.err) {
          console.warn('[AgentLoop] Corrective continuation stream errored (non-fatal):', correctiveConsume.err?.message ?? correctiveConsume.err);
        }
      } catch (correctiveErr: any) {
        console.warn('[AgentLoop] Corrective continuation failed (non-fatal):', correctiveErr?.message ?? correctiveErr);
      }
    }

    const finalText = accumulatedText;

    // Extract summary from <ecomgear-chat-summary> if present
    const summaryMatch = /<ecomgear-chat-summary>([\s\S]*?)<\/ecomgear-chat-summary>/.exec(finalText);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    } else {
      summary = finalText.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim().split('\n')[0] ?? '';
    }

    // Parse ecomgear tags from the full final text as well (XML parser is more reliable)
    parseXmlResponse(finalText, { filesToWrite, filesEdited, filesToDelete, renames, dependencies });

    // ─── Post-generation App.tsx validation ────────────────────────────────────
    // Detects when the agent wrote page files but forgot to update App.tsx.
    // System-prompt instructions alone are unreliable under step-limit pressure
    // or context-compaction drift — this enforces it programmatically.
    if (runtimeMode === 'build' && !abortController.signal.aborted) {
      const normPath = (p: string) => p.replace(/\\/g, '/');

      const appTsxWasUpdated =
        filesToWrite.some(f => normPath(f.path) === 'src/App.tsx') ||
        filesEdited.some(p => normPath(p) === 'src/App.tsx');

      const newPageFiles = filesToWrite
        .map(f => normPath(f.path))
        .filter(p =>
          /^src\/pages\//i.test(p) ||
          /^src\/[A-Z][^/]*Page\.(tsx|jsx)$/i.test(p)
        );

      if (newPageFiles.length > 0 && !appTsxWasUpdated) {
        console.log(`[AgentLoop] Post-gen validation: ${newPageFiles.length} page(s) written but App.tsx not updated — codegenerating App.tsx`);
        sseWrite(res, 'step-finish', { step: 0, toolCount: 0, status: 'Wiring new pages into App.tsx...' });

        let allPagesOnDisk: string[] = [];
        try {
          const pagesDir = safeJoin(appPath, 'src/pages');
          if (fs.existsSync(pagesDir)) {
            allPagesOnDisk = fs.readdirSync(pagesDir)
              .filter(f => /\.(tsx|jsx)$/.test(f))
              .map(f => `src/pages/${f}`);
          }
        } catch { /* ignore */ }

        const pagesForRouter = allPagesOnDisk.length > 0 ? allPagesOnDisk : newPageFiles;

        // Deterministic codegen — zero LLM calls, zero wiring failures. Replaces
        // the old generateText-based "App.tsx fix pass", which could hallucinate
        // routes, forget imports, or truncate mid-file like any other LLM write.
        try {
          const generatedAppTsx = generateAppTsxFromPages(pagesForRouter);
          const fullPath = safeJoin(appPath, 'src/App.tsx');
          fs.writeFileSync(fullPath, generatedAppTsx, 'utf8');
          const existing = filesToWrite.findIndex(f => f.path === 'src/App.tsx');
          if (existing >= 0) filesToWrite[existing].content = generatedAppTsx;
          else filesToWrite.push({ path: 'src/App.tsx', content: generatedAppTsx });
          if (ctx.pendingPreviewFiles) ctx.pendingPreviewFiles.set('src/App.tsx', generatedAppTsx);
          console.log(`[AgentLoop] App.tsx codegen completed — ${pagesForRouter.length} route(s) wired`);
        } catch (appFixErr) {
          console.warn('[AgentLoop] App.tsx codegen failed (non-fatal):', appFixErr);
        }
      }
    }
    // ─── End App.tsx validation ─────────────────────────────────────────────────

    // Constants for binary handling — declared before use in agentWrittenFiles filter.
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.tmp', 'coverage']);
    const SKIP_FILES = new Set(['package-lock.json', '.ecomgear-hash', '.DS_Store', '.env', '.env.local', '.env.production', '.gitignore']);
    const BINARY_EXTS_SET = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.webp', '.mp4', '.mp3', '.pdf', '.zip']);
    const BINARY_SENTINEL = '__ECOMGEAR_BIN64__';

    // Keep only files explicitly written by tool calls and refresh their content from disk.
    const latestWriteByPath = new Map<string, string>();
    for (const file of filesToWrite) {
      latestWriteByPath.set(file.path, file.content);
    }

    // Agent-written files: read fresh from disk (most authoritative).
    // Skip binary files — they are handled by collectDiskFiles as base64.
    const agentWrittenFiles = Array.from(latestWriteByPath.entries())
      .filter(([relativePath]) => {
        const ext = path.extname(relativePath).toLowerCase();
        return !BINARY_EXTS_SET.has(ext);
      })
      .map(([relativePath, fallbackContent]) => {
      try {
        const fullPath = safeJoin(appPath, relativePath);
        if (fs.existsSync(fullPath)) {
          return { path: relativePath, content: fs.readFileSync(fullPath, 'utf8') };
        }
      } catch {
        // Fall back to tracked content if path validation/read fails.
      }
      return { path: relativePath, content: fallbackContent };
    });

    const diskFilesMap = new Map<string, string>();
    const MAX_DISK_FILES = 5000;
    const MAX_TEXT_FILE_SIZE = 512 * 1024; // 512KB per text file
    const collectDiskFiles = (dir: string) => {
      if (diskFilesMap.size >= MAX_DISK_FILES) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (diskFilesMap.size >= MAX_DISK_FILES) return;
        if (SKIP_DIRS.has(entry.name)) continue;
        if (SKIP_FILES.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          collectDiskFiles(fullPath);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          const relPath = path.relative(appPath, fullPath);
          if (!diskFilesMap.has(relPath)) {
            try {
              const stat = fs.statSync(fullPath);
              if (!BINARY_EXTS_SET.has(ext) && stat.size > MAX_TEXT_FILE_SIZE) continue;
              if (BINARY_EXTS_SET.has(ext)) {
                // Encode binary files (images, fonts, etc.) as base64 so they
                // can travel through the JSON sync payload to the preview service.
                const base64 = fs.readFileSync(fullPath).toString('base64');
                diskFilesMap.set(relPath, `${BINARY_SENTINEL}${base64}`);
              } else {
                diskFilesMap.set(relPath, fs.readFileSync(fullPath, 'utf8'));
              }
            } catch { /* skip unreadable */ }
          }
        }
      }
    };
    try { collectDiskFiles(appPath); } catch { /* skip if project dir missing */ }

    for (const { path: p, content: c } of agentWrittenFiles) {
      diskFilesMap.set(p, c);
    }
    const mergedWrites = Array.from(diskFilesMap.entries()).map(([p, c]) => ({ path: p, content: c }));

    // Background KB indexing — fire-and-forget, never blocks the agent response
    if (projectId && mergedWrites.length > 0) {
      Promise.allSettled(
        mergedWrites.map(f => indexFile(projectId, f.path, f.content))
      ).catch(() => {});
    }

    for (const f of mergedWrites) {
      if (/\.(tsx?|jsx?)$/.test(f.path) && !f.path.startsWith('node_modules')) {
        const { content: sanitized, fixes } = sanitizeFileContent(f.path, f.content);
        if (fixes.length > 0) {
          f.content = sanitized;
          try {
            const fullPath = safeJoin(appPath, f.path);
            fs.writeFileSync(fullPath, sanitized, 'utf8');
          } catch {}
          console.log(`[AgentLoop] Final sanitize: ${f.path} — ${fixes.join(', ')}`);
        }

        // TS syntax check — only run on React source files under src/ to avoid
        // noisy config/tooling diagnostics from vite/tailwind/postcss config files.
        const normalizedPath = f.path.replace(/\\/g, '/');
        const isReactSource = /(^|\/)src\/.*\.(tsx|jsx)$/i.test(normalizedPath);
        if (isReactSource) {
          try {
            const tsResult = ts.transpileModule(f.content, {
              compilerOptions: {
                jsx: ts.JsxEmit.ReactJSX,
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ES2020,
              },
              reportDiagnostics: true,
              fileName: f.path,
            });
            if (tsResult.diagnostics && tsResult.diagnostics.length > 0) {
              const errors = tsResult.diagnostics
                .slice(0, 2)
                .map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))
                .join('; ');
              console.warn(`[AgentLoop] Final syntax check failed for ${f.path}: ${errors} — repair loop will fix`);
            }
          } catch { /* don't block push on transpileModule exceptions */ }
        }
      }
      if (/\.json$/i.test(f.path) && !f.path.startsWith('node_modules')) {
        const { content: repaired, fixes } = sanitizeConfigFile(f.path, f.content);
        if (fixes.length > 0) {
          f.content = repaired;
          try {
            const fullPath = safeJoin(appPath, f.path);
            fs.writeFileSync(fullPath, repaired, 'utf8');
          } catch {}
          console.log(`[AgentLoop] Config repair: ${f.path} — ${fixes.join(', ')}`);
        }
      }
    }

    const agentWroteFiles = filesToWrite.length > 0 || filesEdited.length > 0 || filesToDelete.length > 0 || renames.length > 0;

    let previewPushOk = false;
    if (runtimeMode === 'build' && agentWroteFiles) {
      sseWrite(res, 'step-finish', { step: 0, toolCount: 0, status: 'Syncing files to preview...' });
      try {
      const previewServiceUrl = process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001';
      const updateUrl = `${previewServiceUrl}/preview/${projectId}/update`;
      const previewUpdateSecret = process.env.PREVIEW_UPDATE_SECRET || '';
      const { default: http } = await import('node:http');
      const { default: https } = await import('node:https');

      const httpPost = (url: string, body: string, timeoutMs = 15_000): Promise<{ status: number; body: string }> =>
        new Promise((resolve) => {
          const mod = url.startsWith('https') ? https : http;
          const urlObj = new URL(url);
          let responseBody = '';
          const extraHeaders: Record<string, string> = previewUpdateSecret
            ? { 'x-update-secret': previewUpdateSecret }
            : {};
          const req = mod.request({
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
            timeout: timeoutMs,
          }, (r) => {
            r.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
            r.on('end', () => resolve({ status: r.statusCode ?? 0, body: responseBody }));
          });
          req.on('error', (e: Error) => { resolve({ status: 0, body: e.message }); });
          req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
          req.write(body);
          req.end();
        });

      const httpGet = (url: string, timeoutMs = 10_000): Promise<{ status: number; body: string }> =>
        new Promise((resolve) => {
          const mod = url.startsWith('https') ? https : http;
          const urlObj = new URL(url);
          let responseBody = '';
          const req = mod.request({
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            timeout: timeoutMs,
          }, (r) => {
            r.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
            r.on('end', () => resolve({ status: r.statusCode ?? 0, body: responseBody }));
          });
          req.on('error', (e: Error) => { resolve({ status: 0, body: e.message }); });
          req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
          req.end();
        });

      const getPreviewStatus = async (): Promise<{ healthy: boolean; errors: string[]; diagnosticKind?: string }> => {
        const statusRes = await httpGet(`${previewServiceUrl}/preview/${projectId}/status`);
        if (statusRes.status !== 200) {
          return { healthy: false, errors: [`status_unreachable_${statusRes.status || 0}`], diagnosticKind: 'service' };
        }
        try {
          const parsed = JSON.parse(statusRes.body) as { healthy?: boolean; errors?: string[]; diagnosticKind?: string };
          return {
            healthy: Boolean(parsed.healthy),
            errors: Array.isArray(parsed.errors) ? parsed.errors : [],
            diagnosticKind: typeof parsed.diagnosticKind === 'string' ? parsed.diagnosticKind : undefined,
          };
        } catch {
          return { healthy: false, errors: ['status_parse_failed'], diagnosticKind: 'service' };
        }
      };
      // Use the pre-agent disk snapshot for surgical revert.
      // The snapshot was captured at the top of runAgentLoop, before any agent writes.
      // Also capture current disk state before repair loop starts
      const diskBeforeRepair = new Map<string, string>();
      for (const f of mergedWrites) {
        diskBeforeRepair.set(f.path, f.content);
      }

      // First attempt: normal push
      const firstAttempt = await httpPost(updateUrl, JSON.stringify({ files: mergedWrites, fullSync: true }));
      if (firstAttempt.status === 200) {
        console.log(`[AgentLoop] Preview push OK: ${mergedWrites.length} files`);
        previewPushOk = true;
      } else if (firstAttempt.status === 422) {
        console.warn(`[AgentLoop] Preview validation failed (422). Attempting surgical revert of broken files.`);

        // ── Surgical revert: identify broken files from the 422 response and
        // replace them with the pre-agent version before trying LLM repair.
        // This is much faster and more reliable than the full LLM repair loop.
        try {
          const errBody = JSON.parse(firstAttempt.body);
          const validationErrors: Array<{ file?: string }> = Array.isArray(errBody?.validationErrors) ? errBody.validationErrors : [];
          const brokenFiles = new Set(validationErrors.map(e => e.file).filter(Boolean) as string[]);

          if (brokenFiles.size > 0 && brokenFiles.size <= 10) {
            // Use pre-agent snapshot (disk state captured before push) which
            // works even when frontend doesn't send existingFiles.
            const preAgentMap = preAgentDiskSnapshot;

            let reverted = 0;
            let removed = 0;
            const revertedMerged = mergedWrites
              .map(f => {
                if (brokenFiles.has(f.path)) {
                  if (preAgentMap.has(f.path)) {
                    // File existed before agent — restore original version
                    reverted++;
                    return { path: f.path, content: preAgentMap.get(f.path)! };
                  } else {
                    // File is NEW (created by agent) and broken — remove from push
                    removed++;
                    return null;
                  }
                }
                return f;
              })
              .filter((f): f is { path: string; content: string } => f !== null);

            if (reverted > 0 || removed > 0) {
              console.log(`[AgentLoop] Surgical revert: reverted ${reverted}, removed ${removed} broken file(s): ${[...brokenFiles].join(', ')}`);
              const revertAttempt = await httpPost(updateUrl, JSON.stringify({ files: revertedMerged, fullSync: true }));
              if (revertAttempt.status === 200) {
                console.log(`[AgentLoop] Surgical revert succeeded — preview is healthy`);
                // Update mergedWrites so 'done' sends the reverted set
                mergedWrites.length = 0;
                revertedMerged.forEach(f => mergedWrites.push(f));
                // Also revert the on-disk files so they match what was pushed
                for (const brokenPath of brokenFiles) {
                  const preContent = preAgentMap.get(brokenPath);
                  if (preContent != null) {
                    try {
                      const fullFilePath = safeJoin(appPath, brokenPath);
                      fs.writeFileSync(fullFilePath, preContent, 'utf8');
                    } catch { /* best-effort disk revert */ }
                  } else {
                    // New file created by agent — delete from disk
                    try {
                      const fullFilePath = safeJoin(appPath, brokenPath);
                      fs.unlinkSync(fullFilePath);
                    } catch { /* best-effort delete */ }
                  }
                }
                previewPushOk = true;
                const revertMsg = [
                  reverted > 0 ? `reverted ${reverted}` : '',
                  removed > 0 ? `removed ${removed} new broken` : '',
                ].filter(Boolean).join(' and ');
                console.log(`[AgentLoop] Surgical revert complete (silent): ${revertMsg} file(s)`);
              } else {
                console.warn(`[AgentLoop] Surgical revert still failed (${revertAttempt.status}) — falling to LLM repair`);
              }
            }
          }
        } catch {
          // 422 body parse failed — fall through to LLM repair
        }
      } else {
        console.warn(`[AgentLoop] Preview push returned ${firstAttempt.status}`);
      }

      const pushWasTransportFailure = firstAttempt.status !== 200 && firstAttempt.status !== 422 && !previewPushOk;

      let repairDiagnosticKind: string = 'build';
      // Captures last known errors from repair loop — used by salvage block (outer scope)
      let lastRepairErrors: string[] = [];

      if (previewPushOk) {
        sseWrite(res, 'step-finish', { step: 0, toolCount: 0, status: 'Verifying build...' });
        await new Promise<void>(r => setTimeout(r, 600));
        let status = await getPreviewStatus();
        if (!status.healthy) {
          previewPushOk = false;
          repairDiagnosticKind = status.diagnosticKind ?? 'build';
          const hint = status.errors.slice(0, 1).join('\n') || 'unknown preview error';
          console.warn(`[AgentLoop] Preview reported unhealthy after successful push (${repairDiagnosticKind}): ${hint}`);
        } else {
          // Second check at 1.2s total — catches slower Vite transforms on production
          await new Promise<void>(r => setTimeout(r, 600));
          status = await getPreviewStatus();
          if (!status.healthy) {
            previewPushOk = false;
            repairDiagnosticKind = status.diagnosticKind ?? 'build';
            const hint = status.errors.slice(0, 1).join('\n') || 'unknown preview error';
            console.warn(`[AgentLoop] Preview reported unhealthy on second check (${repairDiagnosticKind}): ${hint}`);
          }
        }
      }
      if (!previewPushOk && !pushWasTransportFailure) {
        const isRuntimeRepair = repairDiagnosticKind === 'runtime';
        const repairStatusMsg = isRuntimeRepair ? 'Auto-repairing runtime errors...' : 'Auto-repairing build errors...';
        if (!SUPPRESS_RECOVERY_UI) {
          sseWrite(res, 'step-finish', { step: 0, toolCount: 0, status: repairStatusMsg });
        }
        // Skip all repair attempts if already over token budget
        if (abortController.signal.aborted || runTokens.total >= RUN_TOKEN_CAP) {
          console.warn('[AgentLoop] Skipping build repair — token budget already exhausted');
        } else {
        let repairFiles = [...mergedWrites];
        let prevErrorCount = Infinity;
        let prevErrorSignature: string | null = null;
        for (let repairAttempt = 0; repairAttempt < 3; repairAttempt++) {
          const waitMs = repairAttempt === 0 ? 500 : 1200;
          await new Promise<void>(r => setTimeout(r, waitMs));

          const status = await getPreviewStatus();
          // Update kind from the live status in case it changed
          if (!status.healthy && status.diagnosticKind) repairDiagnosticKind = status.diagnosticKind;
          if (!status.healthy && status.errors.some(e => e.startsWith('status_unreachable_'))) {
            if (repairAttempt === 0) {
              await new Promise<void>(r => setTimeout(r, 1200));
              const retryStatus = await getPreviewStatus();
              if (retryStatus.healthy) {
                previewPushOk = true;
                break;
              } else { break; }
            } else { break; }
            continue;
          }

          if (status.healthy) { previewPushOk = true; break; }

          const errors = status.errors.slice(0, 15);
          if (errors.length === 0) break;
          lastRepairErrors = errors;

          const errorSignature = errors
            .map(e => e.split('\n').slice(0, 2).join('\n').trim())
            .sort()
            .join('|');
          if (prevErrorSignature && errorSignature === prevErrorSignature) {
            console.warn(`[AgentLoop] Repair repeating identical error signature (${errors.length} errors) — stopping early`);
            break;
          }

          // Progress check: if error count didn't decrease, bail early
          if (repairAttempt > 0 && errors.length >= prevErrorCount) {
            console.warn(`[AgentLoop] Repair made no progress (${errors.length} errors, was ${prevErrorCount}) — stopping`);
            break;
          }
          prevErrorCount = errors.length;
          prevErrorSignature = errorSignature;

// ── Deduplicate cascading errors (group by root file, max 2 per file) ──
          // One bad export can generate 20 "module not found" errors. Show the LLM
          // the pattern once per file instead of flooding it with duplicates.
          const errsByFile = new Map<string, string[]>();
          const errNoFile: string[] = [];
          for (const err of errors) {
            const fm = err.match(/^([\w./\-]+\.(?:tsx?|jsx?|css|json))(?::\d+)?/m);
            const key = fm ? fm[1] : '__none__';
            if (key === '__none__') { if (errNoFile.length < 2) errNoFile.push(err); continue; }
            if (!errsByFile.has(key)) errsByFile.set(key, []);
            const arr = errsByFile.get(key)!;
            if (arr.length < 2) arr.push(err); // keep max 2 per file
          }
          const dedupedErrors: string[] = [];
          for (const arr of errsByFile.values()) dedupedErrors.push(...arr);
          dedupedErrors.push(...errNoFile);
          const displayErrors = dedupedErrors.slice(0, 8); // hard cap at 8

          const condensedErrors = displayErrors
            .map((e, i) => `[${i + 1}] ${e.split('\n').slice(0, 6).join('\n')}`)
            .join('\n\n');

          // ── Parse broken file paths + line numbers from errors ─────────────
          const brokenFileLocations = new Map<string, number>(); // relPath → errorLine
          for (const err of errors) {
            const m1 = err.match(/^([\w./\-]+\.(?:tsx?|jsx?|css|json)):(\d+)/m);
            if (m1) {
              if (!brokenFileLocations.has(m1[1])) brokenFileLocations.set(m1[1], parseInt(m1[2], 10));
            } else {
              const m2 = err.match(/^([\w./\-]+\.(?:tsx?|jsx?|css|json))(?:\s|$)/m);
              if (m2 && !brokenFileLocations.has(m2[1])) brokenFileLocations.set(m2[1], 1);
            }
          }

          const currentKind = repairDiagnosticKind === 'runtime' ? 'runtime' : 'build';
          console.log(`[AgentLoop] Auto-repair attempt ${repairAttempt + 1}: ${errors.length} ${currentKind} error(s) in ${brokenFileLocations.size} file(s)`);
          if (!SUPPRESS_RECOVERY_UI) {
            sseWrite(res, 'step-finish', { step: 0, toolCount: 0, status: `Auto-repairing ${currentKind} errors (attempt ${repairAttempt + 1})...` });
          }

          // ── PASS -1: Failure memory (zero LLM tokens, cheaper than mechanical) ──
          // Check whether this exact error signature has a previously-VERIFIED
          // fix from any prior run (any project). Only applies llm_diff fixes here —
          // mechanical fixes are already covered by PASS 0's sanitizeFileContent,
          // which runs unconditionally and for free, so re-applying a remembered
          // mechanical fix would be redundant.
          if (currentKind === 'build' && brokenFileLocations.size > 0) {
            for (const [relPath] of brokenFileLocations) {
              if (!/\.(tsx?|jsx?)$/.test(relPath)) continue;
              const matchingError = errors.find(e => e.includes(relPath));
              if (!matchingError) continue;
              const remembered = await lookupFailureFix(matchingError);
              if (!remembered || remembered.fixKind !== 'llm_diff') continue;
              try {
                const fullFilePath = safeJoin(appPath, relPath);
                const original = fs.readFileSync(fullFilePath, 'utf8');
                const diffMatch = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/.exec(remembered.fixContent);
                if (!diffMatch) continue;
                const [, searchText, replaceText] = diffMatch;
                if (!original.includes(searchText)) continue; // signature matched but file content differs too much — skip, let normal passes handle it
                const patched = original.replace(searchText, replaceText);
                fs.writeFileSync(fullFilePath, patched, 'utf8');
                const memPush = await httpPost(updateUrl, JSON.stringify({ files: [{ path: relPath, content: patched }], fullSync: false }));
                if (memPush.status === 200) {
                  await new Promise<void>(r => setTimeout(r, 400));
                  const memHealth = await getPreviewStatus();
                  if (memHealth.healthy) {
                    console.log(`[AgentLoop] Failure-memory fix applied for ${relPath} (hit #${remembered.hitCount + 1}) — LLM repair skipped`);
                    const idx = mergedWrites.findIndex(f => f.path === relPath);
                    if (idx >= 0) mergedWrites[idx].content = patched;
                    else mergedWrites.push({ path: relPath, content: patched });
                    previewPushOk = true;
                  }
                }
              } catch { /* remembered fix didn't apply cleanly — fall through to normal repair passes */ }
              if (previewPushOk) break;
            }
          }
          if (previewPushOk) break; // failure-memory pass already succeeded

          // ── PASS 0: Mechanical repair (zero LLM tokens) ────────────────────
          // Run sanitizeFileContent on broken .tsx/.ts files BEFORE invoking LLM.
          // Fixes: orphan closers, duplicate React imports, truncated JSX — for free.
          // If ALL errors are cleared this way, the LLM call is skipped entirely.
          if (currentKind === 'build' && brokenFileLocations.size > 0) {
            const mechPatched: Array<{ path: string; content: string }> = [];
            for (const [relPath] of brokenFileLocations) {
              if (!/\.(tsx?|jsx?)$/.test(relPath)) continue;
              try {
                const fullFilePath = safeJoin(appPath, relPath);
                const raw = fs.readFileSync(fullFilePath, 'utf8');
                const { content: fixed, fixes } = sanitizeFileContent(relPath, raw);
                if (fixes.length > 0) {
                  fs.writeFileSync(fullFilePath, fixed, 'utf8');
                  mechPatched.push({ path: relPath, content: fixed });
                  console.log(`[AgentLoop] Mechanical fix: ${relPath} — ${fixes.join(', ')}`);
                }
              } catch { /* skip unreadable */ }
            }
            if (mechPatched.length > 0) {
              // Push only the patched files (partial update, no fullSync needed)
              const mechPush = await httpPost(updateUrl, JSON.stringify({ files: mechPatched, fullSync: false }));
              if (mechPush.status === 200) {
                await new Promise<void>(r => setTimeout(r, 400));
                const mechHealth = await getPreviewStatus();
                if (mechHealth.healthy) {
                  console.log(`[AgentLoop] Mechanical repair cleared all errors — LLM skipped`);
                  for (const p of mechPatched) {
                    const idx = mergedWrites.findIndex(f => f.path === p.path);
                    if (idx >= 0) mergedWrites[idx].content = p.content;
                    else mergedWrites.push(p);
                  }
                  previewPushOk = true;
                  break; // skip LLM entirely
                }
                if (mechHealth.diagnosticKind) repairDiagnosticKind = mechHealth.diagnosticKind;
              }
            }
          }
          if (previewPushOk) break; // mechanical pass already succeeded

          // ── PASS 1: LLM repair with token-efficient context snippets ──────
          // Send ±40 lines around the error line instead of full files.
          // For a 300-line file this cuts context tokens by ~85%.
          let brokenFileContext = '';
          if (brokenFileLocations.size > 0 && brokenFileLocations.size <= 10) {
            const contextParts: string[] = [];
            for (const [relPath, errorLine] of brokenFileLocations) {
              // Skip npm packages — they can't be fixed by editing source files
              if (!relPath.startsWith('src/') && !relPath.startsWith('./')) continue;
              try {
                const fullFilePath = safeJoin(appPath, relPath);
                const raw = fs.readFileSync(fullFilePath, 'utf8');
                const lines = raw.split('\n');
                if (lines.length <= 80) {
                  // Short files: send complete content
                  contextParts.push(`=== ${relPath} ===\n${raw}`);
                } else {
                  // Long files: send imports (lines 1-12) + window around error (±40)
                  const winStart = Math.max(0, errorLine - 40);
                  const winEnd = Math.min(lines.length, errorLine + 40);
                  const importSection = winStart > 12
                    ? lines.slice(0, 12).map((l, i) => `${i + 1}: ${l}`).join('\n') + '\n...\n'
                    : '';
                  const window = lines
                    .slice(winStart, winEnd)
                    .map((l, i) => `${winStart + i + 1}: ${l}`)
                    .join('\n');
                  contextParts.push(`=== ${relPath} (lines ${winStart + 1}–${winEnd} of ${lines.length}) ===\n${importSection}${window}`);
                }
              } catch { /* file may not exist */ }
            }
            if (contextParts.length > 0) {
              brokenFileContext = `\n\n# Relevant file sections\n\n${contextParts.join('\n\n')}`;
            }
          }

          const repairFilesToWrite: Array<{ path: string; content: string }> = [];
          const repairCtx: AgentContext = {
            appPath,
            projectId,
            pendingPreviewFiles: ctx.pendingPreviewFiles,
            previewServiceUrl: ctx.previewServiceUrl,
            onXmlComplete: (xml: string) => {
              parseXmlOperation(xml, { filesToWrite: repairFilesToWrite, filesEdited: [], filesToDelete: [], renames: [], dependencies: [] });
              sseWrite(res, 'tool-output', { xml });
            },
            onXmlStream: (xml: string) => {
              sseWrite(res, 'tool-streaming', { xml });
            },
          };
          const repairToolSet = buildToolSet(repairCtx, []);

          const repairSystemPrompt = repairDiagnosticKind === 'runtime'
            ? (
'You are a runtime-error repair agent. Tool calls only — ZERO chat text.\n\n' +
'RULES: edit_file for targeted fixes; write_file only for full rewrites. Fix ONLY the crash.\n' +
'Files must be complete — no placeholders like `// rest of code`.\n\n' +
'ERROR → FIX:\n' +
'- "Cannot read properties of undefined/null" → add `?.` or `if (!x) return null`\n' +
'- "X is not a function" → wrong import (default vs named) — read_file the source\n' +
'- "Element type is invalid" → component exported wrong — read_file source\n' +
'- "React Hook called conditionally" → move ALL hooks before any if/early return\n' +
'- "Maximum update depth exceeded" → fix useEffect deps array\n' +
'- "Objects are not valid as React child" → extract string property, not whole object\n' +
'- "X is not iterable" → add `|| []` fallback\n' +
'- "Cannot destructure X of undefined" → add null check or `?? {}`\n\n' +
'PROTOCOL: think → read_file crashing file → edit_file root cause → get_build_errors once.\n' +
'Budget: 10 tool calls max.'
            ) : (
'You are a build-error repair agent. Tool calls only — ZERO chat text.\n\n' +
'RULES: write_file for broken files (complete, no placeholders). edit_file for tiny patches.\n' +
'No explicit React import needed (Vite JSX transform). shadcn: `import * as React from "react"`.\n' +
'Export name must match filename: HomePage.tsx → export default function HomePage().\n\n' +
'ERROR → FIX:\n' +
'- "Module not found" → list_files to find it, write_file to create if missing\n' +
'- "X is not exported from Y" → read_file source, fix import to match actual export\n' +
'- "Unexpected token" / truncated file → write_file a clean complete version\n' +
'- "Cannot find name X" → add import at top\n' +
'- "Duplicate identifier" → remove the duplicate\n' +
'- "JSX unclosed tag" → write_file the whole component\n' +
'- "Type X not assignable" → read BOTH files, align the types\n\n' +
'PROTOCOL: think (find ROOT CAUSE — one bad export causes 20 cascade errors) → list_files once\n' +
'→ read_file broken files → fix ALL in one batch → get_build_errors once to verify.\n' +
'Budget: 12 tool calls max.'
            );

          // Snapshot broken files BEFORE the repair call so a successful outcome
          // can be diffed and stored in failure memory for future occurrences.
          const preRepairContent = new Map<string, string>();
          for (const [relPath] of brokenFileLocations) {
            try { preRepairContent.set(relPath, fs.readFileSync(safeJoin(appPath, relPath), 'utf8')); } catch { /* file may not exist yet */ }
          }

          try {
            await generateText({
              model: aiProvider,
              system: repairSystemPrompt,
              messages: [{ role: 'user', content: `Fix these ${currentKind} errors:\n\n${condensedErrors}${brokenFileContext}` }],
              tools: repairToolSet,
              stopWhen: stepCountIs(12),
              abortSignal: abortController.signal,
            });
          } catch (repairErr) {
            console.warn(`[AgentLoop] Repair pass ${repairAttempt + 1} failed:`, repairErr);
            break;
          }

          // Re-scan disk after repair
          const repairedDiskMap = new Map<string, string>();
          const reCollectDisk = (dir: string) => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
              if (SKIP_DIRS.has(entry.name)) continue;
              if (SKIP_FILES.has(entry.name)) continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                reCollectDisk(fullPath);
              } else {
                const ext = path.extname(entry.name).toLowerCase();
                const relPath = path.relative(appPath, fullPath);
                try {
                  if (BINARY_EXTS_SET.has(ext)) {
                    repairedDiskMap.set(relPath, `${BINARY_SENTINEL}${fs.readFileSync(fullPath).toString('base64')}`);
                  } else {
                    repairedDiskMap.set(relPath, fs.readFileSync(fullPath, 'utf8'));
                  }
                } catch {}
              }
            }
          };
          try { reCollectDisk(appPath); } catch {}
          repairFiles = Array.from(repairedDiskMap.entries()).map(([p, c]) => ({ path: p, content: c }));

          // Push repaired files
          const repairPush = await httpPost(updateUrl, JSON.stringify({ files: repairFiles, fullSync: true }));
          // Always update mergedWrites to latest disk state regardless of outcome
          mergedWrites.length = 0;
          repairFiles.forEach(f => mergedWrites.push(f));
          if (repairPush.status === 200) {
            // Push returning 200 does NOT guarantee the build is healthy —
            // quickViteBuildCheck may have found esbuild errors and stored them
            // in projectDiagnostics while still returning 200. Verify /status.
            await new Promise<void>(r => setTimeout(r, 800));
            const repairHealth = await getPreviewStatus();
            if (repairHealth.healthy) {
              console.log(`[AgentLoop] Auto-repair ${repairAttempt + 1} succeeded and preview confirmed healthy`);
              previewPushOk = true;
              console.log(`[AgentLoop] Auto-repair ${repairAttempt + 1} resolved all errors (silent).`);

              // ── Store verified fix in failure memory for next occurrence ──────
              // Only store when the diff is small and clean — a full-file rewrite
              // makes a poor SEARCH/REPLACE template for a different file's content.
              for (const [relPath, errorLine] of brokenFileLocations) {
                const before = preRepairContent.get(relPath);
                const after = repairedDiskMap.get(relPath);
                if (!before || !after || before === after) continue;
                const matchingError = errors.find(e => e.includes(relPath));
                if (!matchingError) continue;
                const diff = buildMinimalSearchReplace(before, after);
                if (diff) {
                  storeFailureFix(matchingError, 'llm_diff', diff).catch(() => {});
                }
              }
              break;
            } else {
              // Update kind for the next repair pass
              if (repairHealth.diagnosticKind) repairDiagnosticKind = repairHealth.diagnosticKind;
              console.warn(`[AgentLoop] Auto-repair ${repairAttempt + 1} push OK but preview still unhealthy (${repairHealth.errors.slice(0, 1).join('; ')}) — continuing repair`);
            }
          } else {
            console.warn(`[AgentLoop] Auto-repair ${repairAttempt + 1} did not pass validation (${repairPush.status})`);
          }
        }
        } // end token-budget guard for repair loop
      } // end if (!previewPushOk && !pushWasTransportFailure) — repair section

      if (!previewPushOk && !pushWasTransportFailure) {
          // All repair attempts exhausted. Silently restore the pre-agent state so
          // the user sees a clean working preview instead of broken generated code.
          console.warn('[AgentLoop] All repair attempts exhausted — silently restoring pre-agent state');

          // Notify frontend so it can show the Auto-fix button
          if (lastRepairErrors.length > 0) {
            sseWrite(res, 'repair-failed', { errors: lastRepairErrors.slice(0, 5) });
          }

          if (preAgentDiskSnapshot.size > 0) {
            // Restore disk files to pre-agent state
            for (const [relPath, preContent] of preAgentDiskSnapshot) {
              try {
                const fullFilePath = safeJoin(appPath, relPath);
                fs.mkdirSync(path.dirname(fullFilePath), { recursive: true });
                fs.writeFileSync(fullFilePath, preContent, 'utf8');
              } catch { /* best-effort */ }
            }
            const preAgentFiles = Array.from(preAgentDiskSnapshot.entries()).map(([p, c]) => ({ path: p, content: c }));
            mergedWrites.length = 0;
            preAgentFiles.forEach(f => mergedWrites.push(f));
            // Push the clean pre-agent state to the preview service
            try {
              await httpPost(updateUrl, JSON.stringify({ files: preAgentFiles, fullSync: true }));
              console.log(`[AgentLoop] Pre-agent state restored to preview (${preAgentFiles.length} files)`);
            } catch {
              console.warn('[AgentLoop] Pre-agent restore push failed — preview may be stale');
            }
          } else {
            // No pre-agent snapshot available — scan disk and push whatever is there
            const salvageDiskMap = new Map<string, string>();
            const collectSalvage = (dir: string) => {
              let entries: fs.Dirent[];
              try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
              for (const entry of entries) {
                if (SKIP_DIRS.has(entry.name)) continue;
                if (SKIP_FILES.has(entry.name)) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                  collectSalvage(fullPath);
                } else {
                  const ext = path.extname(entry.name).toLowerCase();
                  const relPath = path.relative(appPath, fullPath);
                  try {
                    if (BINARY_EXTS_SET.has(ext)) {
                      salvageDiskMap.set(relPath, `${BINARY_SENTINEL}${fs.readFileSync(fullPath).toString('base64')}`);
                    } else {
                      salvageDiskMap.set(relPath, fs.readFileSync(fullPath, 'utf8'));
                    }
                  } catch {}
                }
              }
            };
            try { collectSalvage(appPath); } catch {}
            const salvageFiles = Array.from(salvageDiskMap.entries()).map(([p, c]) => ({ path: p, content: c }));
            mergedWrites.length = 0;
            salvageFiles.forEach(f => mergedWrites.push(f));
            try {
              await httpPost(updateUrl, JSON.stringify({ files: salvageFiles, fullSync: true }));
            } catch {}
          }
        }
      } catch (pushErr) {
        console.warn('[AgentLoop] Preview push error:', pushErr);
        throw pushErr;
      }
    } else if (runtimeMode === 'build' && !agentWroteFiles) {
      console.log(`[AgentLoop] No file operations — skipping preview push`);
      if (outerFinishReason === 'tool-calls') {
        sseWrite(res, 'text-delta', {
          text: '\n\n> I ran out of steps before completing the changes. Please send your request again and I\'ll continue from where I left off.',
        });
      }
    }

    const doneFilesToWrite = (runtimeMode === 'plan' || !agentWroteFiles) ? [] : [...mergedWrites];
    // Include rename "from" paths in filesToDelete so the frontend removes old file entries
    // from workspace state (otherwise both old and new path persist after a rename).
    const renameFromPaths = renames.map(r => r.from).filter(p => !filesToDelete.includes(p));
    const doneFilesToDelete = (runtimeMode === 'plan' || !agentWroteFiles) ? [] : [...filesToDelete, ...renameFromPaths];
    const doneRenames = (runtimeMode === 'plan' || !agentWroteFiles) ? [] : [...renames];
    const doneDependencies = (runtimeMode === 'plan' || !agentWroteFiles) ? [] : [...dependencies];
    const unsupportedPreviewDependencies = doneDependencies.filter((pkg) => !PRE_INSTALLED_PACKAGES.includes(pkg));

    if (unsupportedPreviewDependencies.length > 0) {
      // Legacy XML-declared packages not in the pre-installed set — these should now
      // be installed via run_command by the agent. Show a mild warning for visibility.
      sseWrite(res, 'text-delta', {
        text: `\n> *Note: ${unsupportedPreviewDependencies.join(', ')} ${unsupportedPreviewDependencies.length === 1 ? 'was' : 'were'} declared via legacy <ecomgear-add-dependency>. In future runs, use \`run_command\` to install packages directly.*\n\n`,
      });
    }

    // NOW send 'done' — preview is synced, frontend shows correct state
    sseWrite(res, 'done', {
      ghostRun: runtimeMode === 'build' && !agentWroteFiles,
      filesToWrite: doneFilesToWrite,
      filesToDelete: doneFilesToDelete,
      renames: doneRenames,
      dependencies: doneDependencies,
      mode: runtimeMode,
      summary,
      tokensUsed: runTokens.total || 0,
      // Only expose snapshot to frontend when code actually changed
      snapshotId: doneFilesToWrite.length > 0 ? snapshotId : null,
      previewPushed: previewPushOk,
    });

    // ── Background: save token usage + npm install (non-blocking) ───────────
    void (async () => {
      // runTokens is already populated by onStepFinish at this point.
      // Fall back to result.usage only if onStepFinish captured nothing (e.g. non-Anthropic provider).
      let tokensUsed = runTokens.total;
      if (tokensUsed === 0) {
        try {
          const usage = await result!.usage;
          tokensUsed = usage?.totalTokens ?? 0;
          runTokens.inputTokens  = (usage as any)?.promptTokens     ?? (usage as any)?.inputTokens     ?? 0;
          runTokens.outputTokens = (usage as any)?.completionTokens ?? (usage as any)?.outputTokens    ?? 0;
        } catch {}
      }

      const finalCost = calcCost(runTokens.inputTokens, runTokens.outputTokens, runTokens.cacheReadTokens, runTokens.cacheWriteTokens);

      if (tokensUsed > 0) {
        sseWrite(res, 'usage', {
          tokensUsed,
          breakdown: {
            input:       runTokens.inputTokens,
            output:      runTokens.outputTokens,
            cacheRead:   runTokens.cacheReadTokens,
            cacheWrite:  runTokens.cacheWriteTokens,
          },
          estimatedCostUsd: parseFloat(finalCost.toFixed(5)),
        });
      }

      // Update agent_runs with all completion data (status + token count + snapshot_id)
      if (supabase && agentRunId) {
        supabase.from('agent_runs').update({
          status: 'completed',
          steps_taken: stepCount,
          files_written: doneFilesToWrite.length,
          files_deleted: doneFilesToDelete.length,
          dependencies: doneDependencies,
          summary,
          tokens_used: tokensUsed,  // column added in 20260405130000_agent_runs_tokens.sql
          request_tier:       _tier ?? null,
          model_used:         modelId,
          estimated_cost_usd: finalCost,
          input_tokens:       runTokens.inputTokens,
          output_tokens:      runTokens.outputTokens,
          cache_read_tokens:  runTokens.cacheReadTokens,
          cache_write_tokens: runTokens.cacheWriteTokens,
          // Only link snapshot when code actually changed; null means no restore point
          snapshot_id: doneFilesToWrite.length > 0 ? snapshotId : null,
          completed_at: new Date().toISOString(),
        }).eq('id', agentRunId).then(
          ({ error }) => { if (error) console.warn(`[AgentLoop] agent_runs update failed: ${error.message}`); },
          (e: any) => console.warn('[AgentLoop] agent_runs update rejected:', e?.message)
        );
      }

      // If no code changed (ghost run or plan), delete the snapshot dir we pre-created
      if (snapshotDir && doneFilesToWrite.length === 0) {
        fs.promises.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
      }

      // Update the latest revision's preview_url after a successful preview push
      // so the Editor can load it directly without needing to re-sync on open.
      if (supabase && previewPushOk && doneFilesToWrite.length > 0) {
        const publicPreviewBase = process.env.PREVIEW_SERVICE_URL || 'https://preview.ecomgear.app';
        const revisionPreviewUrl = `${publicPreviewBase}/preview/${projectId}/`;
        supabase.from('revisions')
          .update({ preview_url: revisionPreviewUrl, preview_status: 'ready' })
          .eq('project_id', projectId)
          .then(
            ({ error }) => { if (error) console.warn(`[AgentLoop] revision preview_url update failed: ${error.message}`); },
            (e: any) => console.warn('[AgentLoop] revision preview_url update rejected:', e?.message)
          );

        // Capture a screenshot thumbnail — fire-and-forget, never blocks the response
        captureThumbnail(projectId, revisionPreviewUrl, supabase);
      }

      // ── Prune old snapshots for this project (keep MAX_SNAPSHOTS_PER_PROJECT) ──
      // Runs in the background after agent_runs is updated so it can query the DB.
      if (supabase) {
        (async () => {
          try {
            // Fetch all completed snapshots for this project, oldest first
            const { data: runs } = await supabase
              .from('agent_runs')
              .select('id, snapshot_id, created_at')
              .eq('project_id', projectId)
              .eq('status', 'completed')
              .not('snapshot_id', 'is', null)
              .order('created_at', { ascending: false });

            if (!runs || runs.length <= MAX_SNAPSHOTS_PER_PROJECT) return;

            const toprune = runs.slice(MAX_SNAPSHOTS_PER_PROJECT);
            const pruneIds = toprune.map((r: any) => r.id);
            const pruneSnapshotIds = toprune.map((r: any) => r.snapshot_id as string).filter(Boolean);

            // Delete snapshot directories from disk
            for (const sid of pruneSnapshotIds) {
              const dir = path.join(SNAPSHOTS_DIR, sid);
              try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* skip */ }
            }

            // Clear snapshot_id from those DB rows (they're gone from disk)
            await supabase
              .from('agent_runs')
              .update({ snapshot_id: null })
              .in('id', pruneIds);
          } catch (pruneErr) {
            console.warn('[AgentLoop] Snapshot pruning failed:', pruneErr);
          }
        })();
      }
    })();

    if (agentTimeoutId) clearTimeout(agentTimeoutId);
    clearInterval(heartbeatId);
    return { filesToWrite: doneFilesToWrite, filesToDelete: doneFilesToDelete, renames: doneRenames, dependencies: doneDependencies, summary };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (agentTimeoutId) clearTimeout(agentTimeoutId);
    clearInterval(heartbeatId);

    const isAbort = abortController.signal.aborted || err?.name === 'AbortError';
    if (isAbort) {
      if (abortSignal?.aborted) {
        console.warn('[AgentLoop] Aborted due to client disconnect');
      } else {
        console.warn('[AgentLoop] Aborted due to timeout/cancellation');
      }

      const abortError = err instanceof Error ? err : new Error('Generation cancelled');
      (abortError as { sseErrorEmitted?: boolean }).sseErrorEmitted = true;
      (abortError as { clientAborted?: boolean }).clientAborted = Boolean(abortSignal?.aborted);

      if (supabase && agentRunId) {
        supabase.from('agent_runs').update({
          status: 'failed',
          error_message: abortSignal?.aborted ? 'Cancelled: client disconnected' : 'Cancelled: aborted',
          completed_at: new Date().toISOString(),
        }).eq('id', agentRunId).then(() => {}, () => {});
      }

      throw abortError;
    }

    console.error('[AgentLoop] Error:', err);

    let errorMessage = err?.message ?? 'Agent loop failed';

    // Network errors: give a clear, actionable message instead of the raw DNS error
    if (isNetworkError(err)) {
      if (isTransientStreamDrop(err)) {
        // Mid-stream connection reset — transient, not a server connectivity issue
        errorMessage = 'Connection to AI provider dropped mid-generation (network blip). This is usually temporary — please try again.';
      } else {
        errorMessage = 'Could not reach the AI provider (network error). Check your server\'s internet connectivity or configure a different model in Admin → Settings.';
      }
    }

    // Auth/billing errors: give a clear, actionable message
    if (isAuthOrBillingError(err)) {
      errorMessage = 'AI provider account issue (organization disabled, invalid API key, or insufficient credits). All fallback providers also failed. Please check your provider billing dashboard and API keys in Admin → Settings.';
    }

    // Extract inner AI SDK APICallError messages if present
    if (errorMessage.includes('No output generated')) {
       errorMessage = err?.cause?.message ||
         'AI Provider rejected the request. This is usually caused by insufficient credits (e.g. Anthropic "balance too low") or an invalid API key. Please check your provider billing dashboard or try a different model.';
    }

    // Look for Anthropic specific API errors in the raw data
    if (err?.data?.error?.message) {
      errorMessage = err.data.error.message;
    } else if (err?.responseBody) {
      try {
        const body = JSON.parse(err.responseBody);
        if (body.error?.message) {
          errorMessage = body.error.message;
        }
      } catch {
        // ignore JSON parse error
      }
    }

    sseWrite(res, 'error', { message: errorMessage });
    if (err && typeof err === 'object') {
      (err as { sseErrorEmitted?: boolean }).sseErrorEmitted = true;
    }
    // Update agent_runs on failure
    if (supabase && agentRunId) {
      supabase.from('agent_runs').update({
        status: 'failed',
        error_message: err?.message ?? 'Unknown error',
        completed_at: new Date().toISOString(),
      }).eq('id', agentRunId).then(() => {}, () => {});
    }
    throw err;
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', externalAbortHandler);
    }
  }
}

// ─── XML parsers ──────────────────────────────────────────────────────────────

interface OperationStore {
  filesToWrite: Array<{ path: string; content: string }>;
  filesEdited: string[];
  filesToDelete: string[];
  renames: Array<{ from: string; to: string }>;
  dependencies: string[];
}

function parseXmlOperation(xml: string, store: OperationStore): void {
  // ecomgear-edit (must check before ecomgear-write to avoid partial match)
  const editMatch = /<ecomgear-edit\s+path="([^"]+)"/.exec(xml);
  if (editMatch) {
    if (!store.filesEdited.includes(editMatch[1])) store.filesEdited.push(editMatch[1]);
    return;
  }
  // ecomgear-write
  const writeMatch = /<ecomgear-write\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/ecomgear-write>/.exec(xml);
  if (writeMatch) {
    const p = writeMatch[1];
    const c = writeMatch[2].trim();
    const existing = store.filesToWrite.findIndex((f) => f.path === p);
    if (existing >= 0) store.filesToWrite[existing].content = c;
    else store.filesToWrite.push({ path: p, content: c });
    return;
  }
  // ecomgear-delete
  const deleteMatch = /<ecomgear-delete\s+path="([^"]+)"/.exec(xml);
  if (deleteMatch && !store.filesToDelete.includes(deleteMatch[1])) {
    store.filesToDelete.push(deleteMatch[1]);
    return;
  }
  // ecomgear-rename
  const renameMatch = /<ecomgear-rename\s+from="([^"]+)"\s+to="([^"]+)"/.exec(xml);
  if (renameMatch) {
    store.renames.push({ from: renameMatch[1], to: renameMatch[2] });
    return;
  }
  // ecomgear-add-dependency
  const depMatch = /<ecomgear-add-dependency\s+packages="([^"]+)"/.exec(xml);
  if (depMatch) {
    depMatch[1].split(/\s+/).filter(Boolean).forEach((d) => {
      if (!store.dependencies.includes(d)) store.dependencies.push(d);
    });
  }
}

function parseXmlResponse(text: string, store: OperationStore): void {
  // Run write regex globally
  const writeRe = /<ecomgear-write\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/ecomgear-write>/g;
  let m: RegExpExecArray | null;
  while ((m = writeRe.exec(text)) !== null) {
    const p = m[1], c = m[2].trim();
    const existing = store.filesToWrite.findIndex((f) => f.path === p);
    if (existing >= 0) store.filesToWrite[existing].content = c;
    else store.filesToWrite.push({ path: p, content: c });
  }

  const deleteRe = /<ecomgear-delete\s+path="([^"]+)"/g;
  while ((m = deleteRe.exec(text)) !== null) {
    if (!store.filesToDelete.includes(m[1])) store.filesToDelete.push(m[1]);
  }

  const renameRe = /<ecomgear-rename\s+from="([^"]+)"\s+to="([^"]+)"/g;
  while ((m = renameRe.exec(text)) !== null) {
    store.renames.push({ from: m[1], to: m[2] });
  }

  const depRe = /<ecomgear-add-dependency\s+packages="([^"]+)"/g;
  while ((m = depRe.exec(text)) !== null) {
    m[1].split(/\s+/).filter(Boolean).forEach((d) => {
      if (!store.dependencies.includes(d)) store.dependencies.push(d);
    });
  }
}