import { describe, it, expect } from 'vitest';
import { applyHunks } from '../replace_in_files.js';

const page = `import { supabase } from "@/lib/supabase";
export async function load() {
  const { data } = await supabase.from("payments").select("*");
  const { data: more } = await supabase.from("parents").select("*");
  return data;
}
`;

describe('replace_in_files applyHunks', () => {
  it('applies several hunks to one file in order and reports counts', () => {
    const r = applyHunks(new Map([['src/a.ts', page]]), [
      { path: 'src/a.ts', search: 'import { supabase } from "@/lib/supabase";', replace: 'import { api } from "@/lib/api";' },
      { path: 'src/a.ts', search: 'await supabase.from("payments").select("*")', replace: 'await api.call("get-payments-data")' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.files.get('src/a.ts')).toContain('import { api } from "@/lib/api";');
    expect(r.files.get('src/a.ts')).toContain('api.call("get-payments-data")');
    expect(r.applied).toEqual([{ path: 'src/a.ts', occurrences: 1 }, { path: 'src/a.ts', occurrences: 1 }]);
  });

  it('replaces every occurrence when all is set', () => {
    const r = applyHunks(new Map([['src/a.ts', page]]), [{ path: 'src/a.ts', search: 'supabase.from(', replace: 'db.from(', all: true }]);
    expect(r.ok).toBe(true);
    expect(r.applied[0].occurrences).toBe(2);
    expect(r.files.get('src/a.ts')).not.toContain('supabase.from(');
  });

  it('tolerates trailing whitespace differences in the search text', () => {
    const r = applyHunks(new Map([['src/a.ts', page]]), [{ path: 'src/a.ts', search: 'export async function load() {   \n  const { data }', replace: 'export async function load() {\n  const { data }' }]);
    expect(r.ok).toBe(true);
  });

  it('is all or nothing: a missing hunk in the second file leaves the first untouched', () => {
    const r = applyHunks(new Map([['src/a.ts', page], ['src/b.ts', 'const x = 1;\n']]), [
      { path: 'src/a.ts', search: 'return data;', replace: 'return data ?? [];' },
      { path: 'src/b.ts', search: 'const y = 2;', replace: 'const y = 3;' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/hunk 2: SEARCH text not found in src\/b\.ts/);
  });

  it('refuses a path that does not exist', () => {
    const r = applyHunks(new Map(), [{ path: 'src/missing.ts', search: 'a', replace: 'b' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not exist/);
  });
});
