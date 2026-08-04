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
