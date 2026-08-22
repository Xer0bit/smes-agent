import { test, expect, describe } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { preprocessFile } = require('../materialize.js');

/**
 * The same repair exists in api-gateway's sanitize.ts, but that only runs on
 * the AGENT's write path. The editor's revision->preview sync pushes stored
 * content straight to /update, so a project whose saved revision still holds
 * the old pattern reintroduces it on every sync -- observed 2026-08-22, a
 * swept file overwritten with the broken version minutes later.
 * preprocessFile is the one chokepoint every writer passes through.
 */
describe('preprocessFile repairs fake ${\'/\'} asset interpolation', () => {
  test('asset-directory form', () => {
    const r = preprocessFile('src/components/Logo.tsx', "const s = `${'/'}assets/logo.png`;");
    expect(r.content).toBe('const s = `${import.meta.env.BASE_URL}assets/logo.png`;');
    expect(r.issues.length).toBe(1);
  });

  test('root-level file with a static-asset extension', () => {
    const r = preprocessFile('src/pages/Home.tsx', "style={{ backgroundImage: `url(${'/'}hero.jpg)` }}");
    expect(r.content).toContain('import.meta.env.BASE_URL');
    expect(r.content).not.toContain("${'/'}");
  });

  test('leaves an extensionless route alone', () => {
    const raw = "const p = `${'/'}dashboard`;";
    expect(preprocessFile('src/A.tsx', raw).content).toBe(raw);
  });

  test('does not touch edge-function sources (Deno, not React)', () => {
    const raw = "const s = `${'/'}assets/logo.png`;";
    expect(preprocessFile('supabase/functions/foo/index.ts', raw).content).toBe(raw);
  });

  test('only rewrites code files', () => {
    const raw = "body { background: url(x.png); } /* ${'/'}assets/a.png */";
    expect(preprocessFile('src/index.css', raw).content).toContain("${'/'}assets/a.png");
  });
});
