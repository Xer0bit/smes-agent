/**
 * The parameter names an edge function reads, derived from its source.
 *
 * The settings UI lists each function with what goes in and what comes out.
 * "What goes in" is not stored anywhere: the agent writes a sandbox body that
 * reads free `params`, and the only record of which keys it expects is the
 * code itself. This extracts those keys server-side so the list endpoint can
 * ship names without ever shipping the body -- the client is a list of
 * behaviours, not a code viewer (see the note in EdgeFunctionsSettings.tsx).
 *
 * Purely lexical, on purpose: the three shapes the agent actually writes are
 * `params.x`, `params['x']` / `params["x"]`, and `const { a, b = 1 } = params`.
 * Anything cleverer (aliasing `params` to another name, computed keys) is
 * rare enough that "no declared inputs" is the honest answer for it.
 */

// `(?<![\w$.])` keeps `other.params.x` and `myparams.x` from counting.
const MEMBER_ACCESS = /(?<![\w$.])params\s*\.\s*([A-Za-z_$][\w$]*)/g;
const BRACKET_ACCESS = /(?<![\w$.])params\s*\[\s*(['"])([^'"]+)\1\s*\]/g;
// One level of nesting inside the pattern, enough for `payload = {}` and
// `deep: { x }`; the outer key is still what params must carry.
const DESTRUCTURE = /(?:const|let|var)\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*=\s*(?<![\w$.])params\b/g;

export function extractParamKeys(code: string): string[] {
  const keys = new Set<string>();
  const source = String(code ?? '');

  for (const m of source.matchAll(MEMBER_ACCESS)) keys.add(m[1]);
  for (const m of source.matchAll(BRACKET_ACCESS)) keys.add(m[2]);
  for (const m of source.matchAll(DESTRUCTURE)) {
    // Split on top-level commas only, so `payload = { a: 1, b: 2 }` stays one part.
    for (const part of m[1].replace(/\{[^{}]*\}/g, '{}').split(',')) {
      // `a`, `a = 1`, `a: alias`, `deep: { x }`, `...rest`: the key is
      // whatever precedes `:` or `=`, minus a rest spread.
      const name = part.split(/[:=]/)[0].trim();
      if (!name || name.startsWith('...')) continue;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.add(name);
    }
  }

  return [...keys].sort();
}
