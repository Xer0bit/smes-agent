/**
 * place_asset tool — copy a user-uploaded image from /tmp into project public/assets/.
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
import http from 'node:http';
import { z } from 'zod';
import { ToolDefinition, AgentContext, safeJoin } from './types.js';

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

    // SVG is text-based — check for XML/SVG opening tag
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
  } catch (err: any) {
    return { valid: false, reason: err.message };
  }
}

const schema = z.object({
  tmpPath: z.string().describe(
    'Absolute path to the uploaded file, which must be under /tmp/ecomgear-chat-uploads/',
  ),
  destName: z.string().describe(
    'Destination filename inside public/assets/ — plain filename only, e.g. "logo.png". No directory separators.',
  ),
});

export const placeAssetTool: ToolDefinition<z.infer<typeof schema>> = {
  name: 'place_asset',
  description:
    'Copy a user-uploaded image from temp storage (/tmp) into the project\'s public/assets/ directory so it can be used in the app. ' +
    'ONLY call this when the user explicitly wants to embed the image in the project. ' +
    'NEVER call this for screenshots shared as reference context. ' +
    'IMPORTANT: if you are REPLACING an existing asset (logo, hero image, etc.) you MUST first call ' +
    'delete_file on the OLD asset path (e.g. "public/assets/old-logo.png") BEFORE calling place_asset. ' +
    'After placing, update every component/file that references the old asset to use the new filename.',
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

    // ── Security: destName must be a plain filename — no path traversal ──────
    const safeDest = path.basename(args.destName).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!safeDest || safeDest.startsWith('.') || safeDest.length === 0) {
      return `ERROR: Invalid destination name "${args.destName}". Provide a plain filename like "logo.png".`;
    }

    // ── Validate file is actually an image (magic bytes) ─────────────────────
    const validation = validateImage(resolvedSrc);
    if (!validation.valid) {
      return `ERROR: File validation failed — ${validation.reason}. Only JPEG, PNG, GIF, WebP, and SVG files are allowed.`;
    }

    // ── Size check ────────────────────────────────────────────────────────────
    const stat = fs.statSync(resolvedSrc);
    const sizeKB = Math.round(stat.size / 1024);
    const sizeWarning = sizeKB > 800
      ? `\n⚠ Warning: image is ${sizeKB} KB — consider using a smaller/compressed version for better page load performance.`
      : '';

    // ── Copy to public/assets/ ────────────────────────────────────────────────
    const assetsDir = safeJoin(ctx.appPath, 'public/assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    const destPath = path.join(assetsDir, safeDest);
    fs.copyFileSync(resolvedSrc, destPath);

    // ── Pre-push binary to preview service so preview updates immediately ─────
    try {
      const imgBytes = fs.readFileSync(resolvedSrc);
      const previewServiceUrl = process.env.PREVIEW_SERVICE_URL || 'http://localhost:3001';
      const payload = JSON.stringify({
        files: [{ path: `public/assets/${safeDest}`, content: `__ECOMGEAR_BIN64__${imgBytes.toString('base64')}` }],
        fullSync: false,
      });
      const target = new URL(`${previewServiceUrl}/preview/${ctx.projectId}/update`);
      const req = http.request({
        hostname: target.hostname,
        port: Number(target.port) || 80,
        path: target.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, () => {});
      req.on('error', () => {/* best-effort */});
      req.write(payload);
      req.end();
    } catch { /* best-effort */ }

    return (
      `✓ Image placed: public/assets/${safeDest} (${sizeKB} KB, ${validation.format})${sizeWarning}\n` +
      `Reference in JSX:        <img src={\`\${import.meta.env.BASE_URL}assets/${safeDest}\`} />\n` +
      `Reference as bg (inline): style={{ backgroundImage: \`url(\${import.meta.env.BASE_URL}assets/${safeDest})\` }}\n` +
      `Do NOT use a leading slash like "/assets/${safeDest}" — that breaks the preview.`
    );
  },
};
