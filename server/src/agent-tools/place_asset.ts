/**
 * place_asset tool   copy a user-uploaded image from /tmp into project public/assets/.
 *
 * Images uploaded via chat stay in /tmp until the agent explicitly calls this tool.
 * This prevents any image attachment from accidentally overwriting project assets
 * (e.g. the logo) before the agent understands what the user actually wants.
 *
 * Security guarantees:
 *  - Source must be under /tmp/ecomgear-chat-uploads/ (no path traversal)
 *  - Destination is always inside public/assets/ (plain filename only)
 *  - File is validated with magic-byte check before copying
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin, escapeXmlAttr } from './types.js';

const UPLOAD_BASE = path.join(os.tmpdir(), 'ecomgear-chat-uploads');

/** Known image magic-byte signatures. */
const IMAGE_SIGNATURES: Array<{ bytes: number[]; label: string }> = [
  { bytes: [0xFF, 0xD8, 0xFF],                                    label: 'JPEG' },
  { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],    label: 'PNG'  },
  { bytes: [0x47, 0x49, 0x46, 0x38],                              label: 'GIF'  },
  { bytes: [0x52, 0x49, 0x46, 0x46],                              label: 'WebP (RIFF)' }, // bytes 0-3; bytes 8-11 must be "WEBP"
];

function validateImage(filePath: string): { valid: boolean; format?: string; reason?: string } {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);

    if (bytesRead < 4) return { valid: false, reason: 'File is too small to be a valid image' };

    // SVG is text-based   check for XML/SVG opening tag
    const text = header.toString('utf8', 0, Math.min(bytesRead, 10)).toLowerCase();
    if (text.startsWith('<svg') || text.startsWith('<?xml')) {
      return { valid: true, format: 'SVG' };
    }

    for (const { bytes, label } of IMAGE_SIGNATURES) {
      const sig = Buffer.from(bytes);
      if (header.slice(0, sig.length).equals(sig)) {
        // Extra WebP check: bytes 8-11 must be "WEBP"
        if (label.startsWith('WebP') && header.slice(8, 12).toString('ascii') !== 'WEBP') {
          continue;
        }
        return { valid: true, format: label };
      }
    }
    return { valid: false, reason: 'File does not match any known image format (JPEG, PNG, GIF, WebP, SVG)' };
  } catch (err: unknown) {
    return { valid: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

const schema = z.object({
  tmpPath: z.string().describe(
    'Absolute path to the uploaded file, which must be under /tmp/ecomgear-chat-uploads/',
  ),
  destName: z.string().describe(
    'Destination filename inside public/assets/   plain filename only, e.g. "logo.png". No directory separators.',
  ),
});

export const placeAssetTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'place_asset',
  description:
    'Copy a user-uploaded image from temp storage (/tmp) into the project\'s public/assets/ directory so it can be used in the app. ' +
    'ONLY call this when the user explicitly wants to embed the image in the project. ' +
    'NEVER call this for screenshots shared as reference context. ' +
    'IMPORTANT: if you are REPLACING an existing asset (logo, hero image, etc.), the order is: ' +
    '(1) call place_asset for the NEW file first, (2) call replace_asset_references(oldAssetPath, newAssetPath) to ' +
    'rewrite every reference to the old one, (3) THEN call delete_file on the OLD asset path -- it will now succeed ' +
    'cleanly since no references remain. Do NOT delete the old asset before replacing its references; delete_file ' +
    'will block on the very references replace_asset_references exists to fix.',
  inputSchema: schema,
  modifiesState: true,
  getConsentPreview: (args) => `Place uploaded image → public/assets/${args.destName}`,

  execute: async (args, ctx: AgentContext) => {
    // ── Security: source must be under /tmp/ecomgear-chat-uploads ────────────
    const resolvedSrc = path.resolve(args.tmpPath);
    if (!resolvedSrc.startsWith(path.resolve(UPLOAD_BASE) + path.sep)) {
      return `ERROR: tmpPath must be inside ${UPLOAD_BASE}. Received: "${args.tmpPath}"`;
    }
    if (!fs.existsSync(resolvedSrc)) {
      return (
        `ERROR: Uploaded file not found at "${args.tmpPath}". ` +
        `It may have expired (files are cleaned up after 1 hour). Ask the user to re-attach the image.`
      );
    }

    // ── Security: destName must be a plain filename   no path traversal ──────
    const safeDest = path.basename(args.destName).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!safeDest || safeDest.startsWith('.') || safeDest.length === 0) {
      return `ERROR: Invalid destination name "${args.destName}". Provide a plain filename like "logo.png".`;
    }

    // ── Validate file is actually an image (magic bytes) ─────────────────────
    const validation = validateImage(resolvedSrc);
    if (!validation.valid) {
      return `ERROR: File validation failed   ${validation.reason}. Only JPEG, PNG, GIF, WebP, and SVG files are allowed.`;
    }

    // ── Size check ────────────────────────────────────────────────────────────
    const stat = fs.statSync(resolvedSrc);
    const sizeKB = Math.round(stat.size / 1024);
    const sizeWarning = sizeKB > 800
      ? `\n⚠ Warning: image is ${sizeKB} KB   consider using a smaller/compressed version for better page load performance.`
      : '';

    ctx.placeAssetCallCount = (ctx.placeAssetCallCount ?? 0) + 1;

    // ── Copy to public/assets/ ────────────────────────────────────────────────
    const assetsDir = safeJoin(ctx.appPath, 'public/assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    const destPath = path.join(assetsDir, safeDest);
    fs.copyFileSync(resolvedSrc, destPath);

    // Surface the placed asset in the chat as an activity chip/steps entry AND
    // register it with the same operation-tracking pathway write_file uses.
    // MUST be a real open/close tag, not self-closing: parseXmlOperation's
    // <ecomgear-write> regex requires a closing </ecomgear-write> to match
    // (see agentXmlParser.ts) -- a self-closing tag silently fails to match,
    // so this file never reached agentLoopService.ts's `filesToWrite` array
    // and `agentWroteFiles` stayed false on any place_asset-only turn. That
    // skipped the one reliable, authenticated (x-update-secret +
    // x-agent-lock-token), retried preview-sync path entirely -- the ONLY
    // delivery mechanism left was the unawaited fire-and-forget HTTP push
    // below, which this codebase's own agent_locks check rejects with 423
    // whenever the run holding it doesn't send a matching lock token (which
    // this push never did). Confirmed live: the tool always returned success
    // regardless. Fix: emit a real <ecomgear-write>...</ecomgear-write> so
    // this participates in the exact same tracked-write / full-sync path
    // write_file already uses, and drop the dead push entirely -- content
    // here is a placeholder (binary content is re-read fresh from disk by
    // the full-sync's own disk walk, same as any other binary asset; this
    // entry's only job is to flip `agentWroteFiles` to true).
    const placeholderContent = `[binary asset — ${validation.format}, ${sizeKB} KB — see public/assets/${safeDest} on disk]`;
    ctx.onXmlComplete?.(
      `<ecomgear-write path="${escapeXmlAttr(`public/assets/${safeDest}`)}" description="${escapeXmlAttr(`Placed uploaded image (${validation.format}, ${sizeKB} KB)`)}">${placeholderContent}</ecomgear-write>`
    );

    return (
      `✓ Image copied to public/assets/${safeDest} (${sizeKB} KB, ${validation.format}) on disk.${sizeWarning}\n` +
      `Queued for preview sync — this reaches the live preview when the run's end-of-turn sync completes, not immediately. ` +
      `Do NOT tell the user the preview already shows it until that sync has run (e.g. after your next get_build_errors check comes back healthy).\n` +
      `Reference in JSX:        <img src={\`\${import.meta.env.BASE_URL}assets/${safeDest}\`} />\n` +
      `Reference as bg (inline): style={{ backgroundImage: \`url(\${import.meta.env.BASE_URL}assets/${safeDest})\` }}\n` +
      `Do NOT use a leading slash like "/assets/${safeDest}"   that breaks the preview.`
    );
  },
};
