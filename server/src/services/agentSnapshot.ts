import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SNAPSHOT_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.cache', '.tmp', 'coverage']);

/** Dotfiles that SHOULD be included in snapshots (rollback needs them). */
const SNAPSHOT_INCLUDE_DOTFILES = new Set(['.env.local', '.env.production', '.gitignore', '.eslintrc.json', '.prettierrc']);

/**
 * Persistent snapshots root — survives server restarts.
 * Configurable via SNAPSHOTS_DIR env var (recommended on VPS: /var/www/ecomgear/snapshots).
 * Falls back to ~/.ecomgear/snapshots locally.
 */
export const SNAPSHOTS_DIR = process.env.SNAPSHOTS_DIR
  ? path.resolve(process.env.SNAPSHOTS_DIR)
  : path.join(os.homedir(), '.ecomgear', 'snapshots');

/**
 * Max snapshots kept per project. Oldest are pruned when the limit is exceeded.
 * At ~1-5 MB per snapshot, 20 versions ≈ 20-100 MB per project.
 */
export const MAX_SNAPSHOTS_PER_PROJECT = 20;

/**
 * Atomically snapshot project files to snapshotDir.
 * Copies into a temp dir first, then renames — so a snapshot is either
 * fully present or not present at all (no half-written states).
 */
export async function snapshotProject(appPath: string, snapshotDir: string): Promise<void> {
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

// ─── Gemini run-level context cache ──────────────────────────────────────────
// Caches the full system prompt at the start of each run so steps 2-N are
// cache hits (~80% prompt token savings from step 2 onward).

interface GeminiRunCache { name: string; expiresAt: number; }
const geminiRunCaches = new Map<string, GeminiRunCache>();

export async function createGeminiRunCache(
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
