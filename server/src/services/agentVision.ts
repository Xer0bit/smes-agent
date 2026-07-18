import { generateText } from 'ai';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
// pdf-parse is a CJS module — use createRequire so ESM can import it
let _pdfParse: ((buf: Buffer) => Promise<{ text: string }>) | null = null;
try { _pdfParse = _require('pdf-parse'); } catch { /* not installed — PDF text extraction disabled */ }

// ─── Document text extraction ────────────────────────────────────────────────

/** MIME types where we can extract readable text from the binary file. */
export const EXTRACTABLE_DOC_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         // .xlsx
]);

export async function extractDocumentText(filePath: string, mimeType: string): Promise<string | null> {
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
export function isReferenceScreenshot(analysis: string): boolean {
  const lower = analysis.toLowerCase();
  const screenshotSignals = /screenshot|application window|browser window|web app(?:lication)? interface|software interface|ui capture|dark.*ui|builder.*ui|editor.*ui|app.*screenshot|screen capture|dashboard.*screenshot|admin.*panel|dev.*tool|inspector|console.*log|page layout|full page|webpage/i;
  // Diagrams, wireframes, and annotated sketches shared to explain a concept/layout are
  // reference-only — the agent should use them as visual context, not embed them as assets.
  const diagramSignals = /\bdiagram\b|\bwireframe\b|\bsketch\b|\bmockup\b|\bflowchart\b|\bannot(?:at|ation)\b|\barchitecture\b|\blayout.*(?:diagram|plan|sketch)\b|\bexplanat/i;
  // "standalone asset" is the literal classification term the vision prompt below
  // asks the model to use (category 3) — it must be recognized here, not just
  // narrower phrasings a model might not happen to reach for on its own.
  const strongAssetSignals = /\b(?:standalone logo|isolated logo|transparent background|brand mark only|icon-only|favicon source|logo file|standalone asset)\b/i;
  // Screenshots and diagrams/wireframes are reference context; treat them as such unless
  // the analysis strongly indicates this is a standalone brand asset.
  return (screenshotSignals.test(lower) || diagramSignals.test(lower)) && !strongAssetSignals.test(lower);
}

/**
 * Returns true when the filename alone strongly suggests a screenshot (no vision needed).
 * Covers OS-generated names (Screenshot 2024-..., screen-shot, snap, etc.) and
 * clipboard pastes (image.png, paste*.png, clipboard*).
 */
export function isScreenshotFilename(name: string): boolean {
  return /^(?:screenshot|screen[ _-]?shot|screen[ _-]?capture|screen[ _-]?grab|snap(?:shot)?|capture|scr\d|grab|paste|clipboard|untitled|image\d*\.png$)/i.test(name)
    || /screenshot/i.test(name);
}

/**
 * Returns true when the user's prompt contains explicit intent to use an attached image
 * as a project asset (logo, hero, background, etc.).
 * When false and no vision confirmation, we treat the image as reference-only — safer default.
 */
export function hasEmbedIntent(prompt: string): boolean {
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
export function supportsVision(providerName: string, modelId: string): boolean {
  if (providerName === 'deepseek') return false;
  if (providerName === 'anthropic') return true; // claude-3+ all support vision
  if (providerName === 'gemini')    return true;
  // OpenAI — only vision-capable models
  return modelId.includes('gpt-4o') || modelId.includes('vision');
}


export async function analyzeImageWithVision(
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
