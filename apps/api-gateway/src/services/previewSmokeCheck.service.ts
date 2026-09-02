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

/**
 * The empty-#root decision, extracted pure so it can be tested without a
 * browser. An empty mount is ambiguous -- a genuine runtime crash leaves #root
 * empty, but so does a preview still rebuilding or an app one paint behind. A
 * real crash THROWS (captured as a console/pageerror), so a still-empty root
 * with a clean console is a race, not a crash, and must be skipped rather than
 * failed: failing it triggers a repair pass that re-edits a working app and
 * undoes the fix that just landed.
 *
 * @param rootChildCountAfter #root child count after the settle re-read (>0 = rendered)
 * @param consoleErrorCount   number of real console/page errors captured
 */
/**
 * Console errors this check must ignore, because the agent neither caused them
 * nor can fix them.
 *
 * Every captured error routes the run into `repairDiagnosticKind: 'runtime'`,
 * and the preview renders user-supplied markup in an iframe served from another
 * box -- so third-party noise (a blocked analytics script, a CORS refusal on an
 * external image, a missing favicon) is normal and constant. Treating it as a
 * defect is an unearned repair pass over correct code.
 *
 * Deliberately a denylist of known-external shapes rather than an origin
 * allowlist: the preview's own origin varies per project and per environment,
 * and a wrong allowlist would silently swallow REAL crashes, which is the
 * failure this check exists to catch.
 */
export function isExternalNoise(text: string): boolean {
  return (
    // A failed sub-resource is not a JS crash; a real crash throws separately.
    /^Failed to load resource: the server responded with a status of \d+/i.test(text)
    || /net::ERR_(BLOCKED_BY_CLIENT|BLOCKED_BY_RESPONSE|NAME_NOT_RESOLVED|CONNECTION_REFUSED)/i.test(text)
    || /Access to (fetch|XMLHttpRequest|script|image) at .* has been blocked by CORS policy/i.test(text)
    || /Cross-Origin Read Blocking|blocked by CORS policy/i.test(text)
    || /favicon\.ico/i.test(text)
    || /chrome-extension:\/\//i.test(text)
    || /Content Security Policy directive/i.test(text)
    || /\[vite\] connecting|\[vite\] connected|WebSocket connection to .* failed/i.test(text)
  );
}

export function classifyEmptyRoot(
  rootChildCountAfter: number,
  consoleErrorCount: number,
): 'ok' | 'fail-empty' | 'skip-race' {
  if (rootChildCountAfter > 0) return 'ok';           // rendered during the settle window
  return consoleErrorCount > 0 ? 'fail-empty' : 'skip-race';
}

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
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isExternalNoise(msg.text())) {
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
      // An empty #root is ambiguous: a real runtime crash leaves it empty, but
      // so does a preview still finishing its rebuild or an app whose first
      // paint is a tick late. The difference is that a genuine crash THROWS,
      // and that throw is already captured above as a console/pageerror. So:
      // give the app one short settle window, re-read the mount, and only count
      // a still-empty root as a failure when something actually errored. A bare
      // blank with a clean console is a rebuild/render race, not a crash --
      // degrade it to skipped (exactly like a nav timeout), because acting on
      // it triggers a repair pass that re-edits a working app and undoes the
      // fix that just landed. (2026-08-31: this false positive was re-breaking
      // landed fixes on projects whose preview rebuild outlasted the caller's
      // 2.5s confirm window -- the CQ jobs dashboard being the reported case.)
      await new Promise<void>((r) => setTimeout(r, 3000));
      const rootChildCountAfter = await page.evaluate(() => (globalThis as any).document.getElementById('root')?.children.length ?? -1);
      const verdict = classifyEmptyRoot(rootChildCountAfter, consoleErrors.length);
      if (verdict === 'fail-empty') {
        errors.push('#root rendered empty -- the app mounted nothing.');
      } else if (verdict === 'skip-race') {
        logger.warn(`[PreviewSmokeCheck] #root still empty but console is clean for ${previewUrl} -- treating as a rebuild/render race (skipping, not failing).`);
        return { ok: true, errors: [], skipped: true };
      }
    }

    return { ok: errors.length === 0, errors, skipped: false };
  } catch (err) {
    logger.warn(`[PreviewSmokeCheck] Check itself failed for ${previewUrl} (skipping, not failing): ${(err as Error)?.message}`);
    return { ok: true, errors: [], skipped: true };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
