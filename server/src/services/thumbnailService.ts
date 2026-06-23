/**
 * Takes a screenshot of a project's preview URL and stores it in Supabase Storage.
 * Updates projects.thumbnail_url on success.
 *
 * Uses puppeteer-core with a system-installed chromium binary.
 * Set CHROMIUM_PATH env var to override the default search paths.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[];

const BUCKET = 'thumbnails';
const VIEWPORT = { width: 1280, height: 800 };

async function findChromium(): Promise<string | null> {
  const { access, constants } = await import('node:fs/promises');
  for (const p of CHROMIUM_CANDIDATES) {
    try { await access(p, constants.X_OK); return p; } catch { /* try next */ }
  }
  return null;
}

/**
 * Fire-and-forget: screenshots `previewUrl`, uploads to Storage, updates project row.
 * Never throws — all errors are logged and swallowed.
 */
export async function captureThumbnail(
  projectId: string,
  previewUrl: string,
  supabase: SupabaseClient,
): Promise<void> {
  try {
    const executablePath = await findChromium();
    if (!executablePath) {
      logger.warn('[Thumbnail] No chromium binary found — skipping thumbnail capture. Set CHROMIUM_PATH or install chromium.');
      return;
    }

    const { launch } = await import('puppeteer-core');
    const browser = await launch({
      executablePath,
      headless: 'new' as any,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--hide-scrollbars',
        '--mute-audio',
      ],
    });

    let screenshotBuf: Buffer;
    try {
      const page = await browser.newPage();
      await page.setViewport(VIEWPORT);
      // Wait for network idle so the React app is fully rendered
      await page.goto(previewUrl, { waitUntil: 'networkidle2', timeout: 20_000 });
      screenshotBuf = Buffer.from(await page.screenshot({ type: 'webp', quality: 80 }));
    } finally {
      await browser.close();
    }

    // Upload to Supabase Storage — upsert so re-runs overwrite the same file
    const storagePath = `${projectId}.webp`;
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, screenshotBuf, {
        contentType: 'image/webp',
        upsert: true,
      });

    if (uploadErr) {
      logger.warn(`[Thumbnail] Storage upload failed for ${projectId}: ${uploadErr.message}`);
      return;
    }

    // Get the public URL
    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    const thumbnailUrl = urlData.publicUrl;

    // Update the project row
    const { error: updateErr } = await supabase
      .from('projects')
      .update({ thumbnail_url: thumbnailUrl })
      .eq('id', projectId);

    if (updateErr) {
      logger.warn(`[Thumbnail] projects update failed for ${projectId}: ${updateErr.message}`);
      return;
    }

    logger.info(`[Thumbnail] Captured for project ${projectId} → ${thumbnailUrl}`);
  } catch (err) {
    logger.warn(`[Thumbnail] Capture failed for ${projectId}: ${(err as Error)?.message}`);
  }
}
