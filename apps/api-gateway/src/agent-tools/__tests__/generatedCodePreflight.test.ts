/**
 * A false block is worse than a miss: it stops legitimate work on a customer's
 * project. So the tests that matter most here are the ones asserting we DON'T
 * fire — particularly on Supabase's own `{ data, error }`, which is correct
 * code and appears in nearly every generated project.
 *
 * The positive cases are the exact bytes that shipped to production on
 * 2026-08-30 and threw in cqjobs and 38 Digital.
 */
import { describe, it, expect } from 'vitest';
import { inspectGeneratedCode } from '../generatedCodePreflight.js';

const codes = (path: string, src: string) => inspectGeneratedCode(path, src).map((i) => i.code);

describe('the real production failures', () => {
  it('catches the env value hardcoded to undefined (cqjobs src/lib/api.ts)', () => {
    const src = `
const functionsApiUrl = undefined as string | undefined;
const anonKey = undefined as string | undefined;
`;
    expect(codes('src/lib/api.ts', src)).toEqual(['env_hardcoded_undefined', 'env_hardcoded_undefined']);
  });

  it('catches the supabase client built from undefined (cqjobs src/lib/supabase.ts)', () => {
    const src = `
const supabaseUrl = undefined
const supabaseAnonKey = undefined
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
`;
    expect(codes('src/lib/supabase.ts', src)).toEqual(['env_hardcoded_undefined', 'env_hardcoded_undefined']);
  });

  it('catches reading .data off an edge-function response', () => {
    const src = `
async function invokeEdgeFunction(name) {
  const response = await fetch(\`\${functionsApiUrl}/\${name}/invoke\`, { method: 'POST' });
  const result = await response.json();
  return result.data as T;
}
`;
    expect(codes('src/lib/api.ts', src)).toEqual(['edge_invoke_data_envelope']);
  });

  it('catches it on a property read too, not just a return (38 Digital)', () => {
    const src = `
const res = await fetch(url + '/invoke', { method: 'POST' });
const result = await res.json();
setForm({ fullName: result.data.name, email: result.data.email });
`;
    expect(codes('src/components/UserCreateForm.tsx', src)).toEqual(['edge_invoke_data_envelope']);
  });
});

describe('what must NOT be blocked', () => {
  it('leaves the Supabase client own { data, error } alone', () => {
    // This is correct code in nearly every generated project. Blocking it
    // would break far more than the bug this guard exists for.
    const src = `
const { data, error } = await supabase.from('gigs').select('*');
if (error) throw error;
return data;
`;
    expect(codes('src/lib/db.ts', src)).toEqual([]);
  });

  it('leaves .data alone in a file that never calls the runner', () => {
    const src = `
const response = await fetch('https://api.example.com/things');
const result = await response.json();
return result.data;
`;
    expect(codes('src/lib/things.ts', src)).toEqual([]);
  });

  it('allows an ordinary mutable placeholder assigned undefined', () => {
    const src = `let cached = undefined;\nlet retries = undefined;`;
    expect(codes('src/lib/cache.ts', src)).toEqual([]);
  });

  it('allows an undefined comparison, which is not an assignment', () => {
    const src = `if (context === undefined) { throw new Error('no provider'); }`;
    expect(codes('src/contexts/ChatContext.tsx', src)).toEqual([]);
  });

  it('allows a config value read properly from env', () => {
    const src = `
const functionsApiUrl = import.meta.env.VITE_FUNCTIONS_API_URL;
const anonKey = import.meta.env.VITE_DB_ANON_KEY;
`;
    expect(codes('src/lib/api.ts', src)).toEqual([]);
  });

  it('allows .data on an unrelated object inside a runner file', () => {
    // The file DOES call the runner, but this .data belongs to a Supabase
    // response, not the invoke envelope. Only the variable a JSON body was
    // parsed into may be flagged.
    const src = `
const res = await fetch(url + '/invoke', { method: 'POST' });
const result = await res.json();
const payload = result.result;
const supaResult = await supabase.from('gigs').select('*');
return { payload, rows: supaResult.data };
`;
    expect(codes('src/lib/api.ts', src)).toEqual([]);
  });

  it('ignores non-source files entirely', () => {
    expect(codes('README.md', 'const apiUrl = undefined')).toEqual([]);
    expect(codes('public/data.json', '{"apiUrl": null}')).toEqual([]);
  });
});

describe('the corrected form passes', () => {
  it('accepts result.result from the runner', () => {
    const src = `
const response = await fetch(url + '/invoke', { method: 'POST' });
const result = await response.json();
return result.result;
`;
    expect(codes('src/lib/api.ts', src)).toEqual([]);
  });
});

describe('the message tells the model what to do', () => {
  it('names the env vars that are actually available', () => {
    const [issue] = inspectGeneratedCode('src/lib/api.ts', 'const apiUrl = undefined;');
    expect(issue.message).toMatch(/VITE_FUNCTIONS_API_URL/);
    expect(issue.message).toMatch(/import\.meta\.env/);
  });

  it('names the correct property and why the cast hid it', () => {
    const src = `const r = await fetch(u + '/invoke');\nconst result = await r.json();\nreturn result.data;`;
    const [issue] = inspectGeneratedCode('src/lib/api.ts', src);
    expect(issue.message).toMatch(/result\.result/);
    expect(issue.message).toMatch(/\{ result, logs, durationMs \}/);
  });

  it('reports the line so the model can go straight to it', () => {
    const src = `// header\n// header\nconst apiUrl = undefined;`;
    expect(inspectGeneratedCode('src/lib/api.ts', src)[0].line).toBe(3);
  });
});
