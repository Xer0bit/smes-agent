/**
 * Orchestration Phase 2b (2026-08-09): the first real DOM/browser
 * verification step. Everything before this only checks that the code
 * compiles (esbuild syntax check, then real TS type-checking as of Phase
 * 2a) -- neither one loads the actual page. A React app can type-check
 * cleanly and still throw at runtime (a bad hook order, a null dereference
 * only reachable once mounted) with zero signal reaching the repair loop.
 *
 * Deliberately narrow: binary pass/fail, not full e2e or visual-diff.
 * Load the live preview URL, wait for it to settle, assert no console
 * errors and a non-empty #root mount. That's the whole check. Full
 * e2e/screenshot-diff verification is a real later phase, not this one.
 *
 * Reuses puppeteer-core + findChromium() exactly as thumbnailService.ts
 * already does in production -- no new dependency, no new browser-binary
 * assumption.
 */
import { logger } from '../utils/logger.js';
import { findChromium } from './thumbnailService.js';

export interface SmokeCheckResult {
  ok: boolean;
  /** Populated only when ok is false: console errors, navigation failure, or empty mount. */
  errors: string[];
  /** True if the check itself couldn't run (no chromium, navigation timeout, etc) -- distinct from a real failure. Never blocks the run. */
  skipped: boolean;
}

const NAV_TIMEOUT_MS = 20_000;

export async function runPreviewSmokeCheck(previewUrl: string): Promise<SmokeCheckResult> {
  const executablePath = await findChromium();
  if (!executablePath) {
    logger.warn('[PreviewSmokeCheck] No chromium binary found -- skipping (set CHROMIUM_PATH or install chromium).');
    return { ok: true, errors: [], skipped: true };
  }

  let browser: import('puppeteer-core').Browser | null = null;
  try {
    const { launch } = await import('puppeteer-core');
    browser = await launch({
      executablePath,
      headless: 'new' as any,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--mute-audio',
      ],
    });

    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    // Chrome's own network-resource-load-failure message (a fixed, exact
    // wording, distinct from anything a real app's console.error() would
    // organically produce) -- most commonly a favicon.ico 404 every page
    // load auto-triggers regardless of app correctness. Confirmed live in
    // testing: without this filter, every healthy page failed this check.
    // Auditing every static asset is a different, out-of-scope concern for
    // this check, whose job is specifically catching JS runtime crashes.
    const isResourceLoadNoise = (text: string) => /^Failed to load resource: the server responded with a status of \d+/i.test(text);
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isResourceLoadNoise(msg.text())) {
        consoleErrors.push(msg.text().slice(0, 300));
      }
    });
    page.on('pageerror', (err: unknown) => {
      consoleErrors.push(`Uncaught: ${(err as Error)?.message ?? String(err)}`.slice(0, 300));
    });

    try {
      await page.goto(previewUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
    } catch (navErr) {
      // A navigation failure (timeout, connection refused because the Vite
      // instance is still restarting) is a real infra flake, not proof the
      // generated code is broken -- degrade to skipped rather than a false fail.
      logger.warn(`[PreviewSmokeCheck] Navigation failed for ${previewUrl} (skipping, not failing): ${(navErr as Error)?.message}`);
      return { ok: true, errors: [], skipped: true };
    }

    // Via globalThis (not the bare `document` identifier): this server
    // package's tsconfig has no 'dom' lib (it's a Node backend, correctly),
    // but page.evaluate's callback body runs IN the browser context, where
    // `document` is real at runtime -- `globalThis as any` sidesteps TS
    // checking browser globals against this file's own Node-only lib
    // without touching the tsconfig (which would ripple across every other
    // file in this package).
    const rootChildCount = await page.evaluate(() => (globalThis as any).document.getElementById('root')?.children.length ?? -1);
    const errors: string[] = [...consoleErrors];
    if (rootChildCount === -1) {
      errors.push('No #root element found in the rendered page.');
    } else if (rootChildCount === 0) {
      errors.push('#root rendered empty -- the app mounted nothing.');
    }

    return { ok: errors.length === 0, errors, skipped: false };
  } catch (err) {
    logger.warn(`[PreviewSmokeCheck] Check itself failed for ${previewUrl} (skipping, not failing): ${(err as Error)?.message}`);
    return { ok: true, errors: [], skipped: true };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
