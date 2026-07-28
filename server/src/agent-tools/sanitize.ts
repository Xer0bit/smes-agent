/**
 * sanitize.ts   auto-correct common code mistakes before writing to disk.
 *
 * Runs on every write_file and edit_file operation. Catches errors that
 * would cause Vite/Babel build failures, so the agent never writes broken code.
 *
 * Rules applied (in order):
 *  1. Duplicate React import    remove `import React from 'react'` when
 *     `import * as React from "react"` is also present.
 *  2. .tsx/.ts extension in imports   strip file extensions from local imports
 *     (Vite/TypeScript resolves them automatically; explicit extensions break HMR).
 *  3. Missing React in JSX files that use forwardRef/ElementRef   ensure
 *     `import * as React from "react"` is present.
 *  4. Tailwind config   inject shadcn color extensions if missing.
 *  5. Leaked agent narrative   strip chat/explanation text appended after code
 *     (e.g. "</Perfect! I've..." or "<ecomgear-chat-summary>..." in the file body).
 */

import { createRequire } from 'node:module';

interface SanitizeResult {
  content: string;
  fixes: string[];
}

// ── Lucide icon export list ──────────────────────────────────────────────────
// The model imports icons from training memory, not from the installed
// lucide-react   hallucinated names ("Aim") are a module-level SyntaxError
// that blanks the whole generated app (live incident 2026-07-21). The list is
// generated from the preview-service's installed lucide-react .d.ts   see
// data/lucide-icons.json. Regenerate when lucide is upgraded.
const require_ = createRequire(import.meta.url);
const LUCIDE_ICONS: Set<string> = new Set(require_('./data/lucide-icons.json') as string[]);

/** Closest real lucide icon by name, for auto-correcting hallucinated ones. */
function closestLucideIcon(bad: string): string {
  const badLower = bad.toLowerCase();
  // Cheap tiers before edit distance: exact case-insensitive, then prefix.
  for (const name of LUCIDE_ICONS) if (name.toLowerCase() === badLower) return name;
  for (const name of LUCIDE_ICONS) if (name.toLowerCase().startsWith(badLower) || badLower.startsWith(name.toLowerCase())) return name;
  // Levenshtein over the full list (3K names, few ms, only runs on a miss).
  // ponytail: character-distance only, no semantic matching (e.g. "Aim" lands
  // on "Atom", not "Crosshair"). Goal is "app doesn't crash", not "right icon"
  // — upgrade path is an embedding/keyword map if wrong-icon reports show up.
  function editDistance(a: string, b: string): number {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
      let prev = dp[0];
      dp[0] = j;
      for (let i = 1; i <= a.length; i++) {
        const cur = dp[i];
        dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    return dp[a.length];
  }
  let best = 'Circle';
  let bestDist = Infinity;
  for (const name of LUCIDE_ICONS) {
    if (Math.abs(badLower.length - name.length) >= bestDist) continue;
    const d = editDistance(badLower, name.toLowerCase());
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return best;
}

export interface SyntaxBalanceResult {
  balanced: boolean;
  braces: number;    // positive = unclosed, negative = surplus
  parens: number;
  brackets: number;  // square brackets [ vs ]
  score: number;     // abs(braces) + abs(parens) + abs(brackets)   0 is perfect
}

/**
 * Shared token-aware delimiter scanner for JS/TS/JSX source.
 *
 * Root cause fixed here (live incident 2026-07-27): the previous version of
 * this scanner treated every `'` exactly like `"`/`` ` `` as a plain string
 * toggle, with no awareness of `//` / `/* *\/` comments. A single contraction
 * in a comment or JSX text node ("agent's", "don't", "they're"   all over
 * this codebase's own comment style) flips it into "inside a string" for the
 * rest of the file, silently swallowing every real brace/paren/bracket after
 * it. That made write_file/edit_file hard-reject perfectly valid files
 * (confirmed against the live, working Layout.tsx: scored "unbalanced" while
 * actually balanced), burning real agent-loop retries/tokens for every user
 * touching a file with a contraction in a comment.
 *
 * Fix: skip line/block comments entirely, and don't open a `'` string when
 * it's sandwiched between two word characters (the universal shape of a
 * contraction/possessive   a real string literal is never preceded directly
 * by a letter/digit). Template literals track `${...}` nesting so expression
 * braces count as real code, not template text.
 */
function scanDelimiters(content: string): { braces: number; parens: number; brackets: number } {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  // Stack of pending `${` expression depths inside template literals   each
  // entry is the brace-depth at which that expression's `}` closes back into
  // template text (so a nested `{` inside the expression doesn't close it early).
  const templateExprStack: number[] = [];
  let mode: 'code' | 'line-comment' | 'block-comment' | 'dquote' | 'squote' | 'template' = 'code';
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const prev = i > 0 ? content[i - 1] : '';
    const next = i + 1 < content.length ? content[i + 1] : '';

    if (mode === 'line-comment') {
      if (ch === '\n') mode = 'code';
      continue;
    }
    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { i++; mode = 'code'; }
      continue;
    }
    if (mode === 'dquote' || mode === 'squote') {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if ((mode === 'dquote' && ch === '"') || (mode === 'squote' && ch === "'")) mode = 'code';
      continue;
    }
    if (mode === 'template') {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '`') { mode = 'code'; continue; }
      if (ch === '$' && next === '{') {
        i++;
        braces++;
        templateExprStack.push(braces - 1); // resume template text once braces drops back here
        mode = 'code';
        continue;
      }
      continue;
    }

    // mode === 'code'
    if (ch === '/' && next === '/') { i++; mode = 'line-comment'; continue; }
    if (ch === '/' && next === '*') { i++; mode = 'block-comment'; continue; }
    if (ch === '"') { mode = 'dquote'; continue; }
    if (ch === "'") {
      // Contraction/possessive guard: a real string literal is never preceded
      // directly by a letter/digit ("foo'bar'" isn't valid JS). "don't",
      // "it's", "agent's" all have a word char on both sides   skip them.
      const isWordChar = (c: string) => /[A-Za-z0-9_]/.test(c);
      if (isWordChar(prev) && isWordChar(next)) continue;
      mode = 'squote';
      continue;
    }
    if (ch === '`') { mode = 'template'; continue; }
    if (ch === '{') braces++;
    else if (ch === '}') {
      braces--;
      if (templateExprStack.length && braces === templateExprStack[templateExprStack.length - 1]) {
        templateExprStack.pop();
        mode = 'template';
      }
    }
    else if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  return { braces, parens, brackets };
}

/** Lightweight bracket/paren balance check for source files.
 *  Exported so edit_file can validate edits before writing to disk. */
export function checkSyntaxBalance(content: string): SyntaxBalanceResult {
  const { braces, parens, brackets } = scanDelimiters(content);
  const score = Math.abs(braces) + Math.abs(parens) + Math.abs(brackets);
  return { balanced: score === 0, braces, parens, brackets, score };
}

/** Returns true when the file path is a React source file. */
function isJsxFile(filePath: string): boolean {
  return /\.(tsx|jsx)$/.test(filePath);
}

/** Returns true when the file path is a TypeScript/JS source file. */
function isSourceFile(filePath: string): boolean {
  return /\.(tsx?|jsx?)$/.test(filePath);
}

// ── Known-good defaults for scaffold config files ─────────────────────────────
const SCAFFOLD_DEFAULTS: Record<string, string> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2020', useDefineForClassFields: true,
      lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext',
      skipLibCheck: true, moduleResolution: 'bundler',
      allowImportingTsExtensions: true, resolveJsonModule: true,
      isolatedModules: true, noEmit: true, jsx: 'react-jsx',
      strict: false, baseUrl: '.', paths: { '@/*': ['./src/*'] },
    },
    include: ['src'],
  }, null, 2),
  'tsconfig.node.json': JSON.stringify({
    compilerOptions: {
      composite: true, skipLibCheck: true, module: 'ESNext',
      moduleResolution: 'bundler', allowSyntheticDefaultImports: true,
      strict: true, noEmit: true,
    },
    include: ['vite.config.ts'],
  }, null, 2),
};

/** Validate and optionally repair JSON config files.
 *  Returns the original content if valid, or the scaffold default if corrupt. */
export function sanitizeConfigFile(filePath: string, raw: string): SanitizeResult {
  const fixes: string[] = [];
  const basename = filePath.replace(/^(\.?\/)+/, '').replace(/\\/g, '/');

  // All .json files must be valid JSON
  if (/\.json$/i.test(basename)) {
    try {
      JSON.parse(raw);
      return { content: raw, fixes };
    } catch {
      // Content is not valid JSON   use scaffold default if available
      const fallback = SCAFFOLD_DEFAULTS[basename];
      if (fallback) {
        fixes.push(`Replaced corrupt ${basename} (non-JSON content) with scaffold default`);
        return { content: fallback, fixes };
      }
      // Unknown JSON file with no fallback   return as-is (preview will error but we can't guess the schema)
      fixes.push(`Warning: ${basename} contains invalid JSON but no scaffold default available`);
      return { content: raw, fixes };
    }
  }

  return { content: raw, fixes };
}

export function sanitizeFileContent(filePath: string, raw: string): SanitizeResult {
  const fixes: string[] = [];

  // Handle config/JSON files first
  if (/\.json$/i.test(filePath)) {
    return sanitizeConfigFile(filePath, raw);
  }

  if (!isSourceFile(filePath)) {
    return { content: raw, fixes };
  }

  let content = raw;

  // ── Rule 1: Duplicate React import ───────────────────────────────────────────
  // Detects: both `import React from 'react'` AND `import * as React from "react"`
  // Fix: remove the default import line   the namespace import covers all usages.
  const hasDefaultReact = /^import React from ['"]react['"];?\s*$/m.test(content);
  const hasNamespaceReact = /^import \* as React from ['"]react['"];?\s*$/m.test(content);

  if (hasDefaultReact && hasNamespaceReact) {
    content = content.replace(/^import React from ['"]react['"];?\r?\n/m, '');
    fixes.push('Removed duplicate `import React from "react"` (namespace import already present)');
  }

  // ── Rule 2: .tsx / .ts extension in local imports ────────────────────────────
  // Detects: import X from "./Foo.tsx"  →  import X from "./Foo"
  const extInImportRe = /(from\s+['"])([^'"]+)\.(tsx?|jsx?)(['"])/g;
  const beforeExt = content;
  content = content.replace(extInImportRe, (_, before, importPath, _ext, after) => {
    return `${before}${importPath}${after}`;
  });
  if (content !== beforeExt) {
    fixes.push('Stripped .tsx/.ts/.jsx extensions from local imports (Vite resolves them automatically)');
  }

  // ── Rule 3: Ensure React namespace import in forwardRef/ElementRef files ─────
  // When a JSX file uses React.forwardRef or React.ElementRef but has no
  // `import * as React` line, add it.
  if (isJsxFile(filePath)) {
    const usesReactNamespace = /\bReact\.(forwardRef|ElementRef|ComponentPropsWithoutRef|HTMLAttributes|ButtonHTMLAttributes|InputHTMLAttributes|TextareaHTMLAttributes|SelectHTMLAttributes|AnchorHTMLAttributes|FormHTMLAttributes|ImgHTMLAttributes|ThHTMLAttributes|TdHTMLAttributes|RefObject|MutableRefObject|ReactNode|ReactElement|FC|memo|createContext|useContext|useState|useEffect|useRef|useCallback|useMemo|useReducer|useId)\b/.test(content);
    const alreadyHasNamespaceReact = /^import \* as React from ['"]react['"];?\s*$/m.test(content);

    if (usesReactNamespace && !alreadyHasNamespaceReact) {
      // Add namespace import after any existing react imports, or at top
      const existingReactImport = /^import React from ['"]react['"];?\s*\n/m;
      if (existingReactImport.test(content)) {
        content = content.replace(existingReactImport, 'import * as React from "react";\n');
      } else {
        content = 'import * as React from "react";\n' + content;
      }
      fixes.push('Added `import * as React from "react"` (required for React.forwardRef / React.ElementRef usage)');
    }
  }

  // ── Rule 3.5: Hallucinated lucide-react icon names ───────────────────────────
  // Validate every named import from 'lucide-react' against the installed
  // package's real export list; swap unknown names for the closest real icon
  // (both in the import line and at every usage site).
  const lucideImportRe = /import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g;
  for (const m of content.matchAll(lucideImportRe)) {
    for (const rawName of m[1].split(',')) {
      const name = rawName.trim().split(/\s+as\s+/)[0].trim();
      if (!name || LUCIDE_ICONS.has(name)) continue;
      const replacement = closestLucideIcon(name);
      // Word-boundary replace across the whole file so usage sites follow.
      content = content.replace(new RegExp(`\\b${name}\\b`, 'g'), replacement);
      fixes.push(`Replaced non-existent lucide-react icon "${name}" with "${replacement}"`);
    }
  }

  // ── Rule 4: Tailwind config must include shadcn color extensions ─────────────
  // When the agent writes a tailwind.config.ts / tailwind.config.js with a
  // minimal theme (missing the CSS-variable color extensions), inject them.
  // This prevents "The 'bg-background' class does not exist" PostCSS errors.
  if (/tailwind\.config\.(ts|js)$/.test(filePath) && /theme\s*:\s*\{/.test(content)) {
    const hasShadcnColors = /hsl\(var\(--background\)\)/.test(content);
    if (!hasShadcnColors) {
      // Inject the shadcn color extensions into the theme.extend block
      const SHADCN_COLORS = `
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },`;

      // Try to insert inside extend: { ... }
      if (/extend\s*:\s*\{/.test(content)) {
        content = content.replace(/extend\s*:\s*\{/, `extend: {${SHADCN_COLORS}`);
      } else {
        // No extend block   add one inside theme: { ... }
        content = content.replace(/theme\s*:\s*\{/, `theme: {\n    extend: {${SHADCN_COLORS}\n    },`);
      }
      fixes.push('Injected shadcn/ui color extensions into tailwind config (required for bg-background, text-foreground, etc.)');
    }
  }

  // ── Rule 5: Strip leaked agent narrative ─────────────────────────────────────
  // The LLM sometimes appends its prose response to the file content, producing
  // patterns like:
  //   • `<ecomgear-chat-summary>…</ecomgear-chat-summary>` mid-file
  //   • `</Perfect! I've completely rewritten…`  (agent starts reply with `</`)
  //   • `</I'll make sure…`
  // These cause JSX parse errors. Truncate the file at the first such line.
  if (isSourceFile(filePath)) {
    const lines = content.split('\n');
    let cutAt = -1;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();

      // Any ecomgear tag inside a source file is agent prose, never valid code.
      if (trimmed.includes('<ecomgear-')) {
        cutAt = i;
        break;
      }

      // Detect `</Word...` where the character immediately after the tag name is
      // NOT `>` and NOT a letter/digit/dot (i.e. not a valid JSX closing tag).
      // Valid:   </div>   </Button>   </React.Fragment>
      // Invalid: </Perfect!   </I've   </The component   </Fixed
      const invalidClosingTag = /^<\/[A-Za-z][A-Za-z0-9.]*[^A-Za-z0-9.>]/.test(trimmed);
      if (invalidClosingTag) {
        cutAt = i;
        break;
      }
    }

    if (cutAt >= 0) {
      content = lines.slice(0, cutAt).join('\n').trimEnd();
      fixes.push(`Stripped agent narrative that leaked into file content at line ${cutAt + 1}`);
    }
  }

  // ── Rule 6: Detect and fix bracket imbalance ──────────────────────────────
  // The LLM's #1 structural error: generating a valid component, then appending
  // orphan closing brackets/parens after the function body.  Two attack vectors:
  //   a) Surplus orphans that make global balance negative (easy to detect)
  //   b) Orphan closers that COMPENSATE for missing closers inside the function,
  //      making global balance 0 (hard to detect with counting alone)
  //
  // Strategy: Use depth-tracking to find where the last top-level block closes
  // (depth returns to 0). Everything after that point which is a pure closer
  // line is an orphan   strip it unconditionally. Then handle any remaining
  // imbalance (truncated or surplus) with the standard append/strip approach.
  if (isSourceFile(filePath)) {
    /** Count net open braces/parens/brackets, ignoring string/comment content. */
    const countDelimiters = scanDelimiters;

    // ── Phase A: Structural orphan detection via depth tracking ────────────
    // Walk through the file tracking bracket depth.  When depth returns to 0
    // after being positive, that's the end of a top-level block (component/function).
    // Any pure-closer lines after the LAST such point are orphans.
    const lines = content.split('\n');
    let depth = 0;
    let wasPositive = false;
    let componentEndLine = -1;
    {
      // Same comment/contraction-aware mode machine as scanDelimiters, but
      // walked once over the whole file so a `\n` inside a string/comment
      // never falsely resets state, while still checkpointing per line.
      const templateExprStack: number[] = [];
      let mode: 'code' | 'line-comment' | 'block-comment' | 'dquote' | 'squote' | 'template' = 'code';
      let escaped = false;
      let lineIdx = 0;

      for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        const prev = i > 0 ? content[i - 1] : '';
        const next = i + 1 < content.length ? content[i + 1] : '';

        if (ch === '\n' && mode !== 'template') {
          if (mode === 'line-comment') mode = 'code';
          if (depth > 0) wasPositive = true;
          if (wasPositive && depth === 0 && lines[lineIdx].trim()) {
            componentEndLine = lineIdx;
            wasPositive = false;
          }
          lineIdx++;
          continue;
        }
        if (ch === '\n') { lineIdx++; continue; } // inside a template literal   just track the line number

        if (mode === 'line-comment') continue;
        if (mode === 'block-comment') { if (ch === '*' && next === '/') { i++; mode = 'code'; } continue; }
        if (mode === 'dquote' || mode === 'squote') {
          if (escaped) { escaped = false; continue; }
          if (ch === '\\') { escaped = true; continue; }
          if ((mode === 'dquote' && ch === '"') || (mode === 'squote' && ch === "'")) mode = 'code';
          continue;
        }
        if (mode === 'template') {
          if (escaped) { escaped = false; continue; }
          if (ch === '\\') { escaped = true; continue; }
          if (ch === '`') { mode = 'code'; continue; }
          if (ch === '$' && next === '{') { i++; depth++; templateExprStack.push(depth - 1); mode = 'code'; continue; }
          continue;
        }

        // mode === 'code'
        if (ch === '/' && next === '/') { i++; mode = 'line-comment'; continue; }
        if (ch === '/' && next === '*') { i++; mode = 'block-comment'; continue; }
        if (ch === '"') { mode = 'dquote'; continue; }
        if (ch === "'") {
          const isWordChar = (c: string) => /[A-Za-z0-9_]/.test(c);
          if (isWordChar(prev) && isWordChar(next)) continue;
          mode = 'squote';
          continue;
        }
        if (ch === '`') { mode = 'template'; continue; }
        if (ch === '{' || ch === '(') depth++;
        else if (ch === '}' || ch === ')') {
          depth--;
          if (templateExprStack.length && depth === templateExprStack[templateExprStack.length - 1]) {
            templateExprStack.pop();
            mode = 'template';
          }
        }
      }
      // Final line (no trailing \n consumed above)
      if (depth > 0) wasPositive = true;
      if (wasPositive && depth === 0 && lines[lineIdx] && lines[lineIdx].trim()) {
        componentEndLine = lineIdx;
      }
    }

    // Check for orphan closer lines after the component end
    if (componentEndLine >= 0 && componentEndLine < lines.length - 1) {
      const closerPattern = /^\s*[)}\];,]+\s*$/;
      let orphanStart = -1;
      let foundOrphans = false;

      for (let i = componentEndLine + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue; // blank lines between closers   fine
        if (/^export\s+(default\s+)?\w/.test(trimmed)) continue; // valid export statement
        if (closerPattern.test(trimmed)) {
          if (orphanStart < 0) orphanStart = i;
          foundOrphans = true;
        } else {
          // Real code after component end   these aren't orphans
          foundOrphans = false;
          orphanStart = -1;
          break;
        }
      }

      if (foundOrphans && orphanStart >= 0) {
        const removed = lines.length - orphanStart;
        content = lines.slice(0, orphanStart).join('\n').trimEnd() + '\n';
        fixes.push(`Stripped ${removed} orphan closer(s) after component end (depth returned to 0 at line ${componentEndLine + 1})`);
      }
    }

    // ── Phase B: Standard balance repair ──────────────────────────────────
    // After structural orphan removal, fix any remaining imbalance.
    const { braces: braceCount, parens: parenCount, brackets: bracketCount } = countDelimiters(content);

    // Case (a): truncated   append missing closers
    if (braceCount > 0 || parenCount > 0 || bracketCount > 0) {
      const closers: string[] = [];
      for (let i = 0; i < parenCount; i++) closers.push(')');
      for (let i = 0; i < bracketCount; i++) closers.push(']');
      for (let i = 0; i < braceCount; i++) closers.push('}');
      content = content.trimEnd() + '\n' + closers.join('\n') + '\n';
      fixes.push(`Appended ${closers.length} closing bracket(s)   file was truncated (${braceCount} unclosed braces, ${parenCount} unclosed parens, ${bracketCount} unclosed brackets)`);

    // Case (b): surplus closers still remaining after Phase A
    } else if (braceCount < 0 || parenCount < 0 || bracketCount < 0) {
      const orphanLine = /^\s*[)}\];,]+\s*$/;
      const lns = content.split('\n');
      let current = lns.slice();
      let currentScore = Math.abs(braceCount) + Math.abs(parenCount);
      let removed = 0;

      // Strip trailing orphan lines one by one if it improves balance
      while (current.length > 0 && orphanLine.test(current[current.length - 1])) {
        const candidate = current.slice(0, -1);
        const bal = countDelimiters(candidate.join('\n'));
        const candidateScore = Math.abs(bal.braces) + Math.abs(bal.parens);
        if (candidateScore > currentScore) break;
        current = candidate;
        currentScore = candidateScore;
        removed++;
      }

      if (removed > 0) {
        content = current.join('\n').trimEnd() + '\n';
        fixes.push(`Stripped ${removed} surplus trailing closer(s)`);
      }
    }
  }

  // ── Rule 7: Remove duplicate import statements ──────────────────────────────
  // The agent sometimes writes the same import twice. Remove exact duplicate lines.
  if (isSourceFile(filePath)) {
    const lines = content.split('\n');
    const seenImports = new Set<string>();
    const deduped: string[] = [];
    let removed = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^import\s/.test(trimmed) && trimmed.includes('from ')) {
        if (seenImports.has(trimmed)) {
          removed++;
          continue;
        }
        seenImports.add(trimmed);
      }
      deduped.push(line);
    }

    if (removed > 0) {
      content = deduped.join('\n');
      fixes.push(`Removed ${removed} duplicate import statement(s)`);
    }
  }

  // ── Rule 8: Fix common 'export default' after 'export default' ──────────────
  // Agent sometimes writes `export default function X` AND `export default X` at the end.
  if (isSourceFile(filePath)) {
    const exportDefaultCount = (content.match(/^export default /gm) || []).length;
    if (exportDefaultCount > 1) {
      // Keep the first, remove subsequent bare `export default Identifier;` lines
      let found = false;
      const lines = content.split('\n');
      const filtered = lines.filter(line => {
        if (/^export default [A-Z]\w*;?\s*$/.test(line.trim())) {
          if (found) return false;
          // Check if this is the bare re-export (not a function/class declaration)
          if (!/^export default (function|class|const|let|var)\b/.test(line.trim())) {
            found = true;
            return false; // Remove bare re-export, keep the declaration
          }
        }
        return true;
      });
      if (filtered.length < lines.length) {
        content = filtered.join('\n');
        fixes.push('Removed duplicate export default statement');
      }
    }
  }

  return { content, fixes };
}
