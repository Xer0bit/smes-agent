import { describe, it, expect } from 'vitest';
import { sanitizeFileContent } from '../sanitize.js';

describe('sanitizeFileContent diff visibility', () => {
  it('includes a SEARCH/REPLACE diff snippet alongside the terse fix note when a rule changes the file', () => {
    const raw = [
      'import React from "react";',
      'import * as React from "react";',
      '',
      'export default function Foo() {',
      '  return <div />;',
      '}',
    ].join('\n');

    const { fixes, diff } = sanitizeFileContent('src/Foo.tsx', raw);
    expect(fixes.some(f => f.includes('duplicate'))).toBe(true);
    expect(diff).toBeDefined();
    expect(diff).toContain('<<<<<<< SEARCH');
    expect(diff).toContain('import React from "react";');
  });

  it('omits diff when nothing changed', () => {
    const raw = 'export default function Foo() {\n  return null;\n}\n';
    const { fixes, diff } = sanitizeFileContent('src/Foo.tsx', raw);
    expect(fixes).toEqual([]);
    expect(diff).toBeUndefined();
  });
});

/**
 * `${'/'}assets/x.png` looks like an interpolation but is a hardcoded slash,
 * so the URL resolves to the domain root instead of the project's base path
 * (`/preview/<projectId>/`). Found live 2026-08-22 in 27 files across 9
 * customer projects, and it is the root cause of the recurring "logo
 * disappeared again" reports -- intermittent only because nginx's
 * referer-based rescue covers the miss when a usable Referer happens to be
 * present.
 */
describe('fake ${\'/\'} interpolation in asset paths', () => {
  it('rewrites the hardcoded slash to BASE_URL', () => {
    const raw = "const logoSrc = `${'/'}assets/logo.png`;";
    const { content, fixes } = sanitizeFileContent('src/components/Logo.tsx', raw);
    expect(content).toBe('const logoSrc = `${import.meta.env.BASE_URL}assets/logo.png`;');
    expect(fixes.join(' ')).toMatch(/BASE_URL/);
  });

  it('handles double quotes and every asset directory', () => {
    for (const dir of ['assets', 'images', 'fonts', 'icons', 'media']) {
      const { content } = sanitizeFileContent('src/A.tsx', 'src={`${"/"}' + dir + '/x.png`}');
      expect(content, dir).toBe('src={`${import.meta.env.BASE_URL}' + dir + '/x.png`}');
    }
  });

  it('rewrites every occurrence in a file, not just the first', () => {
    const raw = "a=`${'/'}assets/a.png`; b=`${'/'}images/b.svg`;";
    const { content } = sanitizeFileContent('src/A.tsx', raw);
    expect(content).not.toContain("${'/'}");
    expect((content.match(/import\.meta\.env\.BASE_URL/g) ?? []).length).toBe(2);
  });

  it('leaves a correct BASE_URL path untouched', () => {
    const raw = 'src={`${import.meta.env.BASE_URL}assets/logo.png`}';
    const { content, fixes } = sanitizeFileContent('src/A.tsx', raw);
    expect(content).toBe(raw);
    expect(fixes.join(' ')).not.toMatch(/BASE_URL/);
  });

  // Only asset directories are rewritten -- a template that legitimately
  // interpolates a slash elsewhere (a route path, a join) must not be touched.
  it('does not touch a slash interpolation outside an asset path', () => {
    const raw = "const p = `${'/'}dashboard`;";
    const { content } = sanitizeFileContent('src/A.tsx', raw);
    expect(content).toBe(raw);
  });
});

// The 2026-08-22 repair sweep found the same bug on images living at public/
// root, which a directory-only rule silently left behind (14 in one project).
describe('fake ${\'/\'} interpolation on root-level asset files', () => {
  it('rewrites a root-level image with no asset directory', () => {
    for (const raw of [
      "const img = `${'/'}team-1.jpg`;",
      "style={{ backgroundImage: `url(${'/'}about-hero.jpg)` }}",
      'src={`${"/"}map.png`}',
    ]) {
      const { content } = sanitizeFileContent('src/A.tsx', raw);
      expect(content, raw).not.toContain("${'/'}");
      expect(content, raw).not.toContain('${"/"}');
      expect(content, raw).toContain('import.meta.env.BASE_URL');
    }
  });

  it('still leaves an extensionless route path alone', () => {
    for (const raw of ["const p = `${'/'}dashboard`;", "navigate(`${'/'}settings/profile`)"]) {
      const { content } = sanitizeFileContent('src/A.tsx', raw);
      expect(content, raw).toBe(raw);
    }
  });
});
