const fs = require('fs');
const { PLACEHOLDER_APP_TSX } = require('./placeholderApp');
const path = require('path');
const crypto = require('crypto');
const { activeServers } = require('./previewState');
const { validateSourceFile, repairMalformedDefaultStringParams, trimTrailingOrphanClosers } = require('./validation');
const { sendFullReload, isChildInstance } = require('./instanceOps');

// Base Tailwind + shadcn CSS — plain CSS vars, no @apply color-tokens
const TAILWIND_CSS_BASE = `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }
  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;
    --popover: 222.2 84% 4.9%;
    --popover-foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }
  /* Plain CSS — avoids @apply errors when tailwind.config lacks color tokens */
  * { border-color: hsl(var(--border, 214.3 31.8% 91.4%)); }
  body { background-color: hsl(var(--background, 0 0% 100%)); color: hsl(var(--foreground, 222.2 84% 4.9%)); }
}
`;

// A render-time throw anywhere in the tree unmounts React and leaves a blank
// white page with nothing but a console error — this is the "base template
// is just white screen" failure mode. Every project's main.tsx must wrap
// <App /> with this so a broken component shows a visible message instead of
// nothing. See ensureEssentialFiles (writes the file) and preprocessFile's
// main.tsx Fix 4d (ensures every main.tsx actually wraps with it).
const ERROR_BOUNDARY_TSX = `import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Uncaught error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-background text-foreground">
        <div className="max-w-lg w-full space-y-4">
          <h1 className="text-2xl font-bold">Something went wrong</h1>
          <p className="text-muted-foreground">
            This page hit an unexpected error. Try reloading. If it keeps happening, the
            details below say why.
          </p>
          <pre className="text-xs whitespace-pre-wrap break-words rounded-md border border-border p-3 overflow-auto max-h-64">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
`;

// Wraps a bare `<App />` in main.tsx source with <ErrorBoundary>, adding the
// import if needed. Best-effort (only handles the self-closing-tag case
// every scaffold/repair template here produces) — returns the input
// unchanged if already wrapped or if the pattern isn't found. Shared by
// preprocessFile's Fix 4d (runs on files the agent just wrote) and
// ensureEssentialFiles (runs on whatever main.tsx is already on disk, so
// pre-existing projects that never touch main.tsx again still get healed).
function ensureErrorBoundaryWrap(content) {
    if (content.includes('ErrorBoundary') || !/<App\s*\/>/.test(content)) return content;
    const wrapped = content.replace(/<App\s*\/>/, '<ErrorBoundary>\n      <App />\n    </ErrorBoundary>');
    const reactImportMatch = wrapped.match(/(import.*from.*['"]react['"];?\s*\n)/);
    const importLine = "import ErrorBoundary from './components/ErrorBoundary';\n";
    return reactImportMatch ? wrapped.replace(reactImportMatch[0], reactImportMatch[0] + importLine) : importLine + wrapped;
}

// ============================================================
// FILE VALIDATION & AUTO-FIX UTILITIES
// Catches common issues before they reach Vite
// ============================================================

/**
 * Fix common syntax issues in files before writing them
 */
function preprocessFile(filePath, content) {
    // Skip Supabase EDGE FUNCTION files -- Deno backend, not React source.
    // Edge functions always live at the project ROOT under supabase/functions/
    // (Supabase CLI/Lovable convention, e.g. "supabase/functions/foo/index.ts").
    // Real incident (2026-08-12): the old check also matched
    // `filePath.includes('/supabase/')`, which false-positived on the
    // CLIENT-SIDE Supabase wrapper every Lovable-imported project ships at
    // "src/integrations/supabase/client.ts" -- that path contains "/supabase/"
    // too, so EVERY repair in this function (including Fix 3.46's undefined-env-var
    // repair) silently skipped that file. A client.ts with a literal `undefined`
    // Supabase URL throws synchronously at module-eval time, before any
    // component renders -- unrepairable and uncatchable by ErrorBoundary, so it
    // presented as a pure blank white page. `startsWith('supabase/')` alone is
    // the correct, sufficient check for the real convention.
    if (filePath.startsWith('supabase/')) {
        return { content: content ?? '', issues: [] };
    }
    let fixed = content;
    const issues = [];

    // Fake `${'/'}` interpolation in asset paths (2026-08-22). It LOOKS like an
    // interpolation but is a hardcoded slash, so the URL resolves to the domain
    // root instead of this project's Vite base (/preview/<projectId>/) and the
    // image 404s -- or worse, gets index.html from the SPA fallback.
    //
    // The identical repair exists in api-gateway's sanitize.ts, but that only
    // runs on the AGENT's write path. The editor's revision->preview sync
    // pushes stored file content straight to /update, so a project whose saved
    // revision still holds the old pattern reintroduces it on every sync --
    // observed the same day: a swept file was overwritten with the broken
    // version minutes later. preprocessFile is the one chokepoint EVERY writer
    // passes through to land a file on preview disk, so the repair belongs
    // here too rather than only in front of one of them.
    //
    // Matches an asset directory or a filename with a static-asset extension;
    // an extensionless route (`${'/'}dashboard`) has neither and is untouched.
    if (/\.(tsx?|jsx?)$/.test(filePath)) {
        const fakeRootInterp = /\$\{\s*['"]\/['"]\s*\}(?=(?:(?:assets|images|fonts|icons|media)\/|[^`'"\s)]*\.(?:jpe?g|png|svg|webp|gif|ico|avif|woff2?|ttf|otf|mp4|mp3|pdf)\b))/g;
        const beforeFakeRoot = fixed;
        fixed = fixed.replace(fakeRootInterp, '${import.meta.env.BASE_URL}');
        if (fixed !== beforeFakeRoot) {
            issues.push(`${filePath}: replaced \`\${'/'}\` with \`\${import.meta.env.BASE_URL}\` in asset path(s)`);
        }
    }

    // CSS files: ensure @tailwind directives + fix @apply color-token directives
    if (filePath.endsWith('.css')) {
        const isIndexCss = filePath === 'src/index.css' || filePath.endsWith('/src/index.css') || filePath === 'index.css';

        // Fix: @import rules must precede all other statements in CSS.
        // AI often places @import after @tailwind directives which causes a Vite
        // "[vite:css] @import must precede all other statements" error and prevents
        // the CSS from loading (blank page).
        // Move all @import lines to the very top of the file.
        if (isIndexCss && fixed.includes('@import') && fixed.includes('@tailwind')) {
            const lines = fixed.split('\n');
            const importLines = [];
            const otherLines = [];
            for (const line of lines) {
                if (/^\s*@import\s/.test(line)) {
                    importLines.push(line);
                } else {
                    otherLines.push(line);
                }
            }
            if (importLines.length > 0) {
                const reordered = [...importLines, '', ...otherLines].join('\n');
                if (reordered !== fixed) {
                    fixed = reordered;
                    issues.push('Moved @import rules before @tailwind directives');
                }
            }
        }

        if (isIndexCss && !fixed.includes('@tailwind')) {
            fixed = TAILWIND_CSS_BASE + '\n' + fixed;
            issues.push('Prepended @tailwind directives');
        }
        // Strip @apply color-token directives that require matching tailwind.config keys
        const applyFixes = [
            [/@apply\s+(?=[^;]*bg-gradient-to-br)(?=[^;]*from-slate-50)(?=[^;]*via-blue-50)(?=[^;]*to-purple-50)(?=[^;]*text-foreground)(?=[^;]*min-h-screen)[^;]*;/g, 'background-image: linear-gradient(135deg, #f8fafc 0%, #eff6ff 48%, #f5f3ff 100%); color: hsl(var(--foreground, 222.2 84% 4.9%)); min-height: 100vh;'],
            [/@apply\s+border-border\s*;/g, 'border-color: hsl(var(--border, 214.3 31.8% 91.4%));'],
            [/@apply\s+bg-background\s+text-foreground\s*;/g, 'background-color: hsl(var(--background, 0 0% 100%)); color: hsl(var(--foreground, 222.2 84% 4.9%));'],
            [/@apply\s+bg-background\s*;/g, 'background-color: hsl(var(--background, 0 0% 100%));'],
            [/@apply\s+text-foreground\s*;/g, 'color: hsl(var(--foreground, 222.2 84% 4.9%));'],
        ];
        for (const [pattern, replacement] of applyFixes) {
            if (pattern.test(fixed)) {
                fixed = fixed.replace(pattern, replacement);
                issues.push('Replaced @apply color-token with plain CSS');
            }
        }

        // Generic safety net: convert remaining @apply with custom color tokens to plain CSS.
        // Catches patterns like @apply bg-muted, @apply text-accent-foreground, etc.
        const COLOR_TOKENS = {
            background: '0 0% 100%', foreground: '222.2 84% 4.9%',
            primary: '222.2 47.4% 11.2%', 'primary-foreground': '210 40% 98%',
            secondary: '210 40% 96.1%', 'secondary-foreground': '222.2 47.4% 11.2%',
            muted: '210 40% 96.1%', 'muted-foreground': '215.4 16.3% 46.9%',
            accent: '210 40% 96.1%', 'accent-foreground': '222.2 47.4% 11.2%',
            destructive: '0 84.2% 60.2%', 'destructive-foreground': '210 40% 98%',
            popover: '0 0% 100%', 'popover-foreground': '222.2 84% 4.9%',
            card: '0 0% 100%', 'card-foreground': '222.2 84% 4.9%',
            border: '214.3 31.8% 91.4%', input: '214.3 31.8% 91.4%', ring: '222.2 84% 4.9%',
        };
        const tokenNames = Object.keys(COLOR_TOKENS).sort((a, b) => b.length - a.length).join('|');
        const genericApplyRe = new RegExp(
            `@apply\\s+(?:bg|text|border|ring)-(${tokenNames})\\s*;`, 'g'
        );
        fixed = fixed.replace(genericApplyRe, (match, token) => {
            const fallback = COLOR_TOKENS[token];
            const varName = `--${token}`;
            if (match.startsWith('@apply bg-')) {
                issues.push(`Replaced @apply bg-${token} with plain CSS`);
                return `background-color: hsl(var(${varName}, ${fallback}));`;
            } else if (match.startsWith('@apply text-')) {
                issues.push(`Replaced @apply text-${token} with plain CSS`);
                return `color: hsl(var(${varName}, ${fallback}));`;
            } else if (match.startsWith('@apply border-')) {
                issues.push(`Replaced @apply border-${token} with plain CSS`);
                return `border-color: hsl(var(${varName}, ${fallback}));`;
            } else if (match.startsWith('@apply ring-')) {
                issues.push(`Replaced @apply ring-${token} with plain CSS`);
                return `--tw-ring-color: hsl(var(${varName}, ${fallback}));`;
            }
            return match;
        });

        return { content: fixed, issues };
    }

    // Only process TypeScript/JavaScript files
    if (!filePath.match(/\.(tsx?|jsx?|mjs)$/)) {
        return { content: fixed, issues };
    }

    // Fix 1: Remove .tsx/.ts/.jsx/.js extensions from imports
    const extPatterns = [
        { pattern: /from\s+['"]([^'"]+)\.tsx['"]/g, ext: '.tsx' },
        { pattern: /from\s+['"]([^'"]+)\.ts['"]/g, ext: '.ts' },
        { pattern: /from\s+['"]([^'"]+)\.jsx['"]/g, ext: '.jsx' },
        { pattern: /from\s+['"]([^'"]+)\.js['"]/g, ext: '.js' },
    ];
    extPatterns.forEach(({ pattern, ext }) => {
        if (pattern.test(fixed)) {
            fixed = fixed.replace(pattern, 'from "$1"');
            issues.push(`Removed ${ext} extension from imports`);
        }
    });

    // Fix 2: React import injection intentionally removed.
    // The project uses @vitejs/plugin-react with "jsx": "react-jsx" (automatic transform).
    // React is injected by the compiler — explicit `import React` is not needed and
    // causes duplicate-identifier errors when files also import React hooks.

    // Fix 3: Replace class= with className= in JSX
    if ((filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) && / class=/i.test(fixed)) {
        fixed = fixed.replace(/ class=/gi, ' className=');
        issues.push('Fixed class -> className');
    }

    // Fix 3.1: Repair dangling empty string literals in assignment/property contexts only.
    // Examples:
    // - suffix = ',    -> suffix = '',
    // - prefix: ",    -> prefix: "",
    // Keep this narrowly scoped to avoid mutating valid string syntax in other contexts.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(/(\b[a-zA-Z_$][\w$]*\s*=\s*)(['"])(?=\s*[,}\]])/g, '$1$2$2');
        fixed = fixed.replace(/(\b[a-zA-Z_$][\w$]*\s*:\s*)(['"])(?=\s*[,}\]])/g, '$1$2$2');
        if (fixed !== before) {
            issues.push('Fixed dangling empty string literal');
        }
    }

    // Fix 3.13: Repair malformed default-string params in destructuring/signatures.
    // Examples:
    // - suffix = ', prefix = ''
    // - title = ", subtitle = ""
    // This specifically targets a quote right after `=` when the next token is
    // another parameter assignment, and normalizes it to an empty string literal.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(/(\b[a-zA-Z_$][\w$]*\s*=\s*)'(?=\s*,\s*[a-zA-Z_$][\w$]*\s*=)/g, "$1''");
        fixed = fixed.replace(/(\b[a-zA-Z_$][\w$]*\s*=\s*)"(?=\s*,\s*[a-zA-Z_$][\w$]*\s*=)/g, '$1""');
        if (fixed !== before) {
            issues.push('Fixed malformed default string parameter');
        }
    }

    // Fix 3.12: Normalize bare App imports.
    // Some generated outputs use `from "App"`, which breaks module resolution in preview.
    if (/(^|\/)src\/.*\.(tsx|jsx|ts|js)$/.test(filePath)) {
        const before = fixed;
        fixed = fixed.replace(/from\s+['"]App['"]/g, "from '@/App'");
        if (fixed !== before) {
            issues.push('Normalized bare App import path');
        }
    }

    // Fix 3.2: Repair doubled quote typo in function arguments only.
    // Example: console.error('Error:'', err) -> console.error('Error:', err)
    // Require at least one char inside the first string so valid empty literals
    // like '' are not accidentally collapsed back to a single quote.
    //
    // Bug found live 2026-08-11: with no guard on what precedes the opening
    // quote, this misfired on two ADJACENT empty-string literals a few chars
    // apart (e.g. a ternary `cols[i] || "" : "",`) -- it read the closing
    // quote of the FIRST empty string as if it were the opening quote of a
    // new one, treated the text in between as that "string"'s content, and
    // ate one of the two quotes around the second empty string, producing
    // invalid code ("Unterminated string literal") from perfectly valid
    // input. The (?<!['"]) guard rejects starting a match immediately after
    // another quote of the same kind, which is exactly the signal that the
    // "opening" quote we're looking at is actually somebody else's closer.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(/(?<!')('(?:[^'\\\n\r]|\\.)+?)''(?=\s*,)/g, '$1\'');
        fixed = fixed.replace(/(?<!")("(?:[^"\\\n\r]|\\.)+?)""(?=\s*,)/g, '$1"');
        if (fixed !== before) {
            issues.push('Fixed doubled quote typo in function arguments');
        }
    }

    // Fix 3.3: Repair malformed empty-string argument placeholders.
    // Examples:
    // - window.history.replaceState({}, ', window.location.pathname)
    // - someFn(a, ", b)
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(/,\s*'\s*,/g, ", '',");
        fixed = fixed.replace(/,\s*"\s*,/g, ', "",');
        if (fixed !== before) {
            issues.push('Fixed malformed empty-string argument');
        }
    }

    // Fix 3.35: Repair malformed empty-string object values (LLM truncation artifact).
    // Scope this to object-property assignments only so valid string literals
    // like console.error('Error: ', err) are never mutated.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        const malformedPropEmptyStringPattern = /([,{]\s*(?:[A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*)'\s*(?=[,}])/g;
        const malformedPropEmptyDoublePattern = /([,{]\s*(?:[A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*)"\s*(?=[,}])/g;
        const malformedPropSmartQuotePattern = /([,{]\s*(?:[A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*)[‘’]\s*(?=[,}])/g;

        fixed = fixed
            .replace(malformedPropEmptyStringPattern, "$1''")
            .replace(malformedPropEmptyDoublePattern, '$1""')
            .replace(malformedPropSmartQuotePattern, "$1''");

        if (fixed !== before) {
            issues.push('Repaired malformed empty-string object values');
        }
    }

    // Fix 3.4: Repair malformed History API title arg.
    // Example: window.history.replaceState({}, ', window.location.pathname)
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(/(replaceState\(\s*\{\s*\}\s*,\s*)'(?=\s*,)/g, "$1''");
        fixed = fixed.replace(/(replaceState\(\s*\{\s*\}\s*,\s*)"(?=\s*,)/g, '$1""');
        if (fixed !== before) {
            issues.push('Fixed malformed History API title argument');
        }
    }

    // Fix 3.45: Repair dropped `import.meta.env.VITE_*` references in the
    // standard edge-function invoke pattern (app-builder.prompt.ts documents
    // `fetch(\`${import.meta.env.VITE_FUNCTIONS_API_URL}/<name>/invoke\`, {
    // headers: { apikey: import.meta.env.VITE_DB_ANON_KEY } })`   generation
    // has produced the literal JS keyword `undefined` in both slots instead
    // (a real incident: every login/signup call silently became a same-origin
    // relative fetch to ".../undefined/<name>/invoke", 404ing with no signal
    // pointing at the actual cause). `${undefined}` in a template literal
    // always renders as the string "undefined"   no legitimate code wants
    // that, so this is safe to auto-repair rather than just flag.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(/\$\{undefined\}(?=\/[\w-]+\/invoke)/g, '${import.meta.env.VITE_FUNCTIONS_API_URL}');
        fixed = fixed.replace(/(['"]?apikey['"]?\s*:\s*)undefined(?=\s*[,}])/gi, '$1import.meta.env.VITE_DB_ANON_KEY');
        if (fixed !== before) {
            issues.push('Repaired dropped VITE_FUNCTIONS_API_URL/VITE_DB_ANON_KEY env references');
        }
    }

    // Fix 3.46: Same generation defect as Fix 3.45, different shape -- a whole
    // `const x = undefined;` DECLARATION instead of just the template-literal
    // slot. Real incident (CardPro, 2026-08-08): src/lib/supabase.tsx shipped
    // with `const supabaseUrl = undefined; const supabaseAnonKey = undefined;`,
    // silently disabling auth ("Auth service is not configured") with zero
    // signal pointing at the cause -- Fix 3.45's regexes don't match this
    // shape at all. Only repairs an EXACT `= undefined;` initializer for a
    // fixed, known set of variable names (never touches legitimate
    // `import.meta.env.*` text itself, unlike the removed Fix 5 above) --
    // narrow and unambiguous on purpose: a bare `undefined` initializer for
    // a variable named exactly one of these is never intentional.
    //
    // Second real incident (2026-08-12): a Lovable-imported project used the
    // ALL_CAPS Supabase-CLI naming convention instead --
    // `const SUPABASE_URL = undefined; const SUPABASE_PUBLISHABLE_KEY =
    // undefined;` in src/integrations/supabase/client.ts. createClient()
    // throws SYNCHRONOUSLY at module-evaluation time on an invalid URL, i.e.
    // before any component ever renders -- unlike a render-time throw, this
    // can never be caught by a React ErrorBoundary, so it presented as a pure
    // blank white page surviving the ErrorBoundary fix. Added the ALL_CAPS
    // names below; also widened `const` to `const|let` since a bare
    // `undefined` initializer for one of these exact names is never
    // intentional regardless of declaration keyword.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        // VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not platform-provided
        // (2026-09-02): rewriting `supabaseUrl = undefined` to read them would
        // just move the crash from module-eval to createClient with an empty
        // URL. Those names are left for the agent to fix against the app's own
        // auth functions.
        const KNOWN_ENV_VAR_NAMES = {
            apiUrl: 'VITE_FUNCTIONS_API_URL',
            functionsApiUrl: 'VITE_FUNCTIONS_API_URL',
            anonKey: 'VITE_DB_ANON_KEY',
            dbApiUrl: 'VITE_DB_API_URL',
            dbAnonKey: 'VITE_DB_ANON_KEY',
            dbSchema: 'VITE_DB_SCHEMA',
        };
        for (const [varName, envName] of Object.entries(KNOWN_ENV_VAR_NAMES)) {
            const re = new RegExp(`\\b((?:const|let)\\s+${varName}\\s*=\\s*)undefined(\\s*;)`, 'g');
            fixed = fixed.replace(re, `$1import.meta.env.${envName}$2`);
        }
        if (fixed !== before) {
            issues.push('Repaired dropped VITE_* env reference(s) in const declarations');
        }
    }

    // Fix 3.47: The platform-auth client (src/integrations/supabase/client.ts)
    // points every generated project at the SAME Supabase project --
    // database.service.ts: "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are the
    // SMEsAgent platform's OWN Supabase instance ... NOT the per-project hosted
    // database" -- and every preview is served from one origin, differentiated
    // only by URL path. @supabase/supabase-js's default auth lock is a
    // Navigator LockManager lock keyed off that shared URL's hostname, so it's
    // contended across EVERY open preview tab on EVERY project, not just tabs
    // of the same one. A losing tab's lock acquisition throws
    // NavigatorLockAcquireTimeoutError ("Uncaught (in promise) Error:
    // Acquiring an exclusive Navigator LockManager lock ... immediately
    // failed"); depending on where that lands relative to the app's own
    // render gate, it can block mount entirely with zero build error and zero
    // failed request -- same failure class as the undefined-URL incidents
    // above (Fix 3.46), just a different trigger.
    //
    // Preview iframes are short-lived and disposable; they don't need
    // cross-tab-synchronized token refresh, so a no-op lock (run the
    // operation immediately, no Web Locks involved) removes the whole failure
    // class instead of papering over one trigger of it.
    if (filePath.endsWith('integrations/supabase/client.ts')) {
        if (/createClient\(/.test(fixed) && /auth:\s*\{/.test(fixed) && !/\block\s*:/.test(fixed)) {
            const before = fixed;
            fixed = fixed.replace(/(auth:\s*\{)/, '$1\n    lock: (_name, _acquireTimeout, fn) => fn(),');
            if (fixed !== before) {
                issues.push('Added a no-op auth lock to the platform auth client -- previews share one Supabase project across all projects, so the default Navigator Lock can throw and blank the page under contention');
            }
        }
    }

    // Fix 3.5: Fix common event handler casing
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
        const events = ['onclick', 'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onmouseenter', 'onmouseleave'];
        events.forEach(event => {
            const regex = new RegExp(` ${event}=`, 'gi');
            const proper = ` ${event.slice(0, 2)}${event.charAt(2).toUpperCase()}${event.slice(3)}=`;
            if (regex.test(fixed)) {
                fixed = fixed.replace(regex, proper);
                issues.push(`Fixed ${event} -> ${proper.trim()}`);
            }
        });
    }

    // Fix 3.6: Convert BrowserRouter / createBrowserRouter → Hash equivalents.
    // BrowserRouter requires a `basename` prop to work under sub-path hosting and
    // causes parse errors when the agent forgets the space before `basename=`.
    // HashRouter / createHashRouter works out-of-the-box in the preview environment.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts')) {
        if (fixed.includes('BrowserRouter') || fixed.includes('createBrowserRouter')) {
            const before = fixed;
            // Step 1: repair missing space (e.g. <BrowserRouterbasename= → <BrowserRouter basename=)
            fixed = fixed.replace(/<BrowserRouter([a-z])/g, '<BrowserRouter $1');
            // Step 2: replace createBrowserRouter → createHashRouter (must be before BrowserRouter rename)
            fixed = fixed.replace(/\bcreateStaticRouter\b/g, '__STATIC_ROUTER_KEEP__'); // protect unrelated
            fixed = fixed.replace(/\bcreateBrowserRouter\b/g, 'createHashRouter');
            fixed = fixed.replace(/__STATIC_ROUTER_KEEP__/g, 'createStaticRouter');
            // Step 3: replace <BrowserRouter> component and its import name
            fixed = fixed.replace(/\bBrowserRouter\b/g, 'HashRouter');
            // Step 4: strip any basename prop from the resulting HashRouter tag
            fixed = fixed.replace(/<HashRouter([^>]*)\bbasename=(?:\{[^}]*\}|"[^"]*"|'[^']*')([^>]*)>/g, (m, pre, post) => {
                const attrs = (pre + post).trim();
                return attrs ? `<HashRouter ${attrs}>` : '<HashRouter>';
            });
            // Step 5: strip basename option from createHashRouter({ basename: ... }) call
            fixed = fixed.replace(/createHashRouter\((\[[^\]]*\])\s*,\s*\{[^}]*\bbasename\b[^}]*\}\)/gs,
                (m, routes) => `createHashRouter(${routes})`);
            if (fixed !== before) {
                issues.push('Converted BrowserRouter/createBrowserRouter → HashRouter/createHashRouter');
            }
        }
    }

    // Fix 3.6b: Remove <Navigate to="/home"> redirect and promote /home route to /
    // Agents often generate: <Route path="/" element={<Navigate to="/home" replace />} />
    //                         <Route path="/home" element={<HomePage />} />
    // This causes the preview to always redirect to /#/home, which then gets stored
    // as the current route and breaks on any subsequent build that lacks a /home route.
    if ((filePath === 'src/App.tsx' || filePath.endsWith('/App.tsx')) &&
        /Navigate\s+to=["']\/home["']/.test(fixed) &&
        /path=["']\/home["']/.test(fixed)) {
        const before = fixed;
        // Remove the Navigate redirect line entirely
        fixed = fixed.replace(
            /[ \t]*<Route[^>]*path=["']\/["'][^>]*element=\{[^}]*Navigate[^}]*to=["']\/home["'][^}]*\}[^/]*(\/?>|\/>)\s*\n?/g,
            ''
        );
        // Also remove self-closing variant
        fixed = fixed.replace(
            /[ \t]*<Route[^/]*\/>[^\n]*Navigate[^\n]*\/home[^\n]*\n?/g,
            ''
        );
        // Promote /home route to /
        fixed = fixed.replace(
            /path=["']\/home["']/g,
            'path="/"'
        );
        if (fixed !== before) {
            issues.push('Promoted /home route to / and removed Navigate redirect');
        }
    }

    // Fix 3.7: Repair common router closing-tag mismatches (e.g. <HashRouter> ... </Router>)
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
        const before = fixed;
        if (fixed.includes('<HashRouter') && fixed.includes('</Router>') && !fixed.includes('<Router')) {
            fixed = fixed.replace(/<\/Router>/g, '</HashRouter>');
        }
        if (fixed !== before) {
            issues.push('Fixed router closing-tag mismatch');
        }
    }

    // Fix 3.8: Encode raw " inside url('...') → %22 to prevent Babel JSX parse errors
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
        const before = fixed;
        fixed = fixed.replace(/url\((['"])(.*?)\1\)/gs, (m, q, inner) => `url(${q}${inner.replace(/"/g, '%22')}${q})`);
        fixed = fixed.replace(/url\(([^'"()\s][^()]*)\)/gs, (m, inner) => inner.includes('"') ? `url(${inner.replace(/"/g, '%22')})` : m);
        if (fixed !== before) {
            issues.push('Encoded raw quotes in url()');
        }
    }

    // Fix 3.9: Ensure App.tsx and component files have export default
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
        // Check for named function/const components without export
        const componentMatch = fixed.match(/(?:^|\n)(function|const)\s+([A-Z][a-zA-Z0-9]*)\s*(?:=|[(\s])/);
        if (componentMatch) {
            const componentName = componentMatch[2];
            const hasExportDefault = new RegExp(`export\\s+default\\s+${componentName}\\b`).test(fixed) ||
                new RegExp(`export\\s+default\\s+function\\s+${componentName}\\b`).test(fixed);
            if (!hasExportDefault && !fixed.includes('export default')) {
                fixed = fixed.trimEnd() + `\n\nexport default ${componentName};\n`;
                issues.push(`Added missing export default for ${componentName}`);
            }
        }
    }

    // Fix 3.10: Repair unmatched JSX fragment shorthand (<> without </>)
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
        const fragmentOpenCount = (fixed.match(/<>/g) || []).length;
        const fragmentCloseCount = (fixed.match(/<\/>/g) || []).length;

        if (fragmentOpenCount > fragmentCloseCount) {
            const before = fixed;

            // Common failure mode: return ( <> <Router>...</Router> );
            fixed = fixed.replace(/return\s*\(\s*<>\s*/m, 'return (\n    ');

            // Fallback: if no replacement happened, append missing closers before final `);`
            if (fixed === before) {
                const missing = fragmentOpenCount - fragmentCloseCount;
                if (missing > 0) {
                    fixed = fixed.replace(/\n\s*\);\s*$/, `\n${'  '.repeat(2)}${'</>\n'.repeat(missing)}  );`);
                }
            }

            if (fixed !== before) {
                issues.push('Fixed unmatched JSX fragment shorthand');
            }
        }
    }

    // Fix 3.11: Repair common truncated empty-string calls from streamed generation
    // Examples:
    // - num.toString().split(').map(...)   -> split('')
    // - useState(');                       -> useState('')
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;

        // string.split(').map(...) => string.split('').map(...)
        fixed = fixed.replace(/\.split\(\s*'\s*\)(?=\s*\.map\s*\()/g, ".split('')");
        fixed = fixed.replace(/\.split\(\s*"\s*\)(?=\s*\.map\s*\()/g, '.split("")');

        // useState('); / useState("); => useState('') / useState("")
        fixed = fixed.replace(/useState\(\s*'\s*\)(?=\s*[;,\)])/g, "useState('')");
        fixed = fixed.replace(/useState\(\s*"\s*\)(?=\s*[;,\)])/g, 'useState("")');

        if (fixed !== before) {
            issues.push('Fixed truncated empty-string calls');
        }
    }

    // Fix 4: Ensure main.tsx has CSS import
    if (filePath.endsWith('/main.tsx') || filePath === 'src/main.tsx') {
        if (!fixed.includes("import './index.css'") && !fixed.includes('import "./index.css"')) {
            const reactImportMatch = fixed.match(/(import.*from.*['"]react['"];?\s*\n)/);
            if (reactImportMatch) {
                fixed = fixed.replace(
                    reactImportMatch[0],
                    reactImportMatch[0] + "import './index.css';\n"
                );
                issues.push('Added CSS import to main.tsx');
            }
        }

        // Fix 4b: Repair truncated render() — replace whole file if parens unbalanced
        // Handles both `ReactDOM.createRoot(...)` and named-import `createRoot(...)` patterns.
        if (fixed.includes('createRoot') && fixed.includes('.render(')) {
            const renderIdx = fixed.indexOf('.render(');
            if (renderIdx !== -1) {
                const afterRender = fixed.slice(renderIdx + 8);
                let depth = 1, balanced = false;
                for (const ch of afterRender) {
                    if (ch === '(') depth++;
                    else if (ch === ')') { depth--; if (depth === 0) { balanced = true; break; } }
                }
                if (!balanced) {
                    const appImport = (fixed.match(/import\s+App\s+from\s+['"]([^'"]+)['"]/) || [])[1] || './App';
                    fixed = `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from '${appImport}'\nimport ErrorBoundary from './components/ErrorBoundary'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <ErrorBoundary>\n      <App />\n    </ErrorBoundary>\n  </React.StrictMode>,\n)\n`;
                    issues.push('Replaced truncated main.tsx');
                }
            }
        }

        // Fix 4c: Replace near-empty main.tsx
        if (!fixed.includes('createRoot') && fixed.trim().length < 100) {
            fixed = `import React from 'react'\nimport ReactDOM from 'react-dom/client'\nimport App from './App'\nimport ErrorBoundary from './components/ErrorBoundary'\nimport './index.css'\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <ErrorBoundary>\n      <App />\n    </ErrorBoundary>\n  </React.StrictMode>,\n)\n`;
            issues.push('Replaced empty main.tsx');
        }

        // Fix 4d: Ensure <App /> is wrapped in ErrorBoundary. Without this, any
        // render-time throw anywhere in the tree unmounts React and leaves a
        // blank white page — the "base template is white screen" failure mode.
        {
            const wrapped = ensureErrorBoundaryWrap(fixed);
            if (wrapped !== fixed) {
                fixed = wrapped;
                issues.push('Wrapped <App /> in ErrorBoundary');
            }
        }
    }

    // Fix 5 used to blanket-replace every import.meta.env.X (except BASE_URL) with a
    // literal ""   including VITE_DB_API_URL/VITE_DB_ANON_KEY/VITE_SUPABASE_URL/etc.
    // Vite's dev server already provides DEV/PROD/MODE/BASE_URL correctly at runtime,
    // and real project secrets are written to a per-project .env.local file (see the
    // /preview/:projectId/secrets endpoint below) which Vite loads natively — so this
    // file must NOT touch import.meta.env.* text at all. Doing so silently nuked every
    // hosted-database/auth/edge-function call in every preview, unconditionally.

    // Fix 5.5: Remove orphaned closing delimiters after export statements.
    // Common streamed-generation artifact:
    //   export default Component;
    //   }
    //   )}
    // or
    //   export { useToast, toast }
    //   }
    //   }
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        // After `export default X` (semicolon optional), strip trailing lines made only of closers.
        fixed = fixed.replace(/(\nexport\s+default\s+[A-Za-z_$][\w$]*\s*;?)\n((?:\s*[\)\}\];,]+\s*\n)+)/g, '$1\n');
        // After `export { ... }` (semicolon optional), strip same artifacts.
        fixed = fixed.replace(/(\nexport\s*\{[^\n]*\}\s*;?)\n((?:\s*[\)\}\];,]+\s*\n)+)/g, '$1\n');
        // Same-line variant: `export default X; )}`
        fixed = fixed.replace(/(\nexport\s+default\s+[A-Za-z_$][\w$]*\s*;?)\s*[\)\}\];,]+\s*(\n|$)/g, '$1$2');
        fixed = fixed.replace(/(\nexport\s*\{[^\n]*\}\s*;?)\s*[\)\}\];,]+\s*(\n|$)/g, '$1$2');
        if (fixed !== before) {
            issues.push('Removed orphaned closing delimiters after export');
        }
    }

    // Fix 6: Trim trailing orphan closers like standalone ")" or "}" lines.
    // This specifically targets streamed truncation artifacts that trigger
    // "Declaration or statement expected" at EOF.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const trimmed = trimTrailingOrphanClosers(fixed);
        if (trimmed.removed > 0 && trimmed.content !== fixed) {
            fixed = trimmed.content;
            issues.push(`Removed ${trimmed.removed} trailing orphan closer line(s)`);
        }
    }

    // Fix 7: Repair edge-function invoke response unwrap. The server always
    // wraps a function's result as { result, logs, durationMs } (see
    // vps5-functions-runner/runEdgeFunction.js) -- a helper that fetches
    // .../invoke, parses the JSON, and returns it raw silently breaks every
    // caller expecting the unwrapped value (an array to .map(), an object
    // to read fields from). Confirmed live twice in different projects:
    // the model wrote its own custom invoke wrapper instead of following
    // the documented `const { result, error } = await res.json()` pattern
    // and forgot to unwrap. Self-heal it here instead of hand-patching each
    // occurrence -- a manual fix gets silently reverted the next time an
    // agent run rewrites the same file.
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || filePath.endsWith('.ts') || filePath.endsWith('.js')) {
        const before = fixed;
        fixed = fixed.replace(
            /(\/invoke[\s\S]{0,600}?(?:const|let)\s+(\w+)\s*=\s*await\s+[\w.]+\.json\(\)\s*;(?:(?!\breturn\b)[\s\S]){0,300}?)\breturn\s+\2\s*;/g,
            (_match, prefix, varName) => `${prefix}return ${varName}.result;`
        );
        if (fixed !== before) {
            issues.push('Unwrapped edge-function invoke response (.result)');
        }
    }

    return { content: fixed, issues };
}

/**
 * Ensure essential files exist for a valid React project
 */
function ensureEssentialFiles(projectRoot, userFiles) {
    const userFilePaths = new Set(userFiles.map(f => f.path.replace(/^\//, '')));

    // Repair corrupt JSON config files that would crash Vite
    const jsonConfigs = ['tsconfig.json', 'tsconfig.node.json', 'package.json', 'components.json'];
    const JSON_SCAFFOLD = {
        'tsconfig.json': JSON.stringify({
            compilerOptions: {
                target: 'ES2020', useDefineForClassFields: true,
                lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext',
                skipLibCheck: true, moduleResolution: 'bundler',
                allowImportingTsExtensions: true, resolveJsonModule: true,
                isolatedModules: true, noEmit: true, jsx: 'react-jsx',
                strict: true, noUnusedLocals: false, noUnusedParameters: false,
                noFallthroughCasesInSwitch: true, baseUrl: '.', paths: { '@/*': ['./src/*'] },
            },
            include: ['src'], references: [],
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
    for (const configFile of jsonConfigs) {
        const configPath = path.join(projectRoot, configFile);
        if (fs.existsSync(configPath)) {
            try {
                JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } catch {
                const fallback = JSON_SCAFFOLD[configFile];
                if (fallback) {
                    fs.writeFileSync(configPath, fallback);
                    console.warn(`[${path.basename(projectRoot)}] Repaired corrupt ${configFile} with scaffold default`);
                }
            }
        }
    }

    // Linux is case-sensitive: generated projects sometimes create src/app.tsx while
    // main.tsx imports ./App. Create a tiny bridge to avoid boot failures.
    const appPascalTsx = path.join(projectRoot, 'src', 'App.tsx');
    const appPascalJsx = path.join(projectRoot, 'src', 'App.jsx');
    const appLowerTsx = path.join(projectRoot, 'src', 'app.tsx');
    const appLowerJsx = path.join(projectRoot, 'src', 'app.jsx');

    if (!fs.existsSync(appPascalTsx) && !fs.existsSync(appPascalJsx)) {
        if (fs.existsSync(appLowerTsx)) {
            fs.writeFileSync(appPascalTsx, `export { default } from './app';\n`);
            console.log(`[${path.basename(projectRoot)}] Created App.tsx bridge to ./app`);
        } else if (fs.existsSync(appLowerJsx)) {
            fs.writeFileSync(appPascalJsx, `export { default } from './app';\n`);
            console.log(`[${path.basename(projectRoot)}] Created App.jsx bridge to ./app`);
        }
    }

    // Ensure ErrorBoundary.tsx exists — self-heals every project (new AND
    // pre-existing, since this runs on every /update) so a render-time throw
    // can never again unmount React into a blank white page. See Fix 4d above
    // for the matching main.tsx wrap-with-ErrorBoundary invariant.
    const errorBoundaryPath = path.join(projectRoot, 'src', 'components', 'ErrorBoundary.tsx');
    if (!fs.existsSync(errorBoundaryPath)) {
        fs.mkdirSync(path.dirname(errorBoundaryPath), { recursive: true });
        fs.writeFileSync(errorBoundaryPath, ERROR_BOUNDARY_TSX);
        console.log(`[${path.basename(projectRoot)}] Created ErrorBoundary.tsx`);
    }

    // Heal pre-existing projects too: main.tsx is rarely re-sent by the agent
    // after initial scaffold, so relying solely on preprocessFile's Fix 4d
    // (which only runs on files the agent just wrote) would leave old
    // projects' main.tsx unwrapped forever. Repair it directly on disk here,
    // which runs on every /update AND on preview (re)open.
    const mainTsxDiskPath = path.join(projectRoot, 'src', 'main.tsx');
    if (fs.existsSync(mainTsxDiskPath) && !userFilePaths.has('src/main.tsx')) {
        const existingMain = fs.readFileSync(mainTsxDiskPath, 'utf-8');
        const healedMain = ensureErrorBoundaryWrap(existingMain);
        if (healedMain !== existingMain) {
            fs.writeFileSync(mainTsxDiskPath, healedMain);
            console.log(`[${path.basename(projectRoot)}] Wrapped <App /> in ErrorBoundary (main.tsx)`);
        }
    }

    // Check if user provided an index.css
    if (!userFilePaths.has('src/index.css')) {
        const indexCssPath = path.join(projectRoot, 'src', 'index.css');
        if (!fs.existsSync(indexCssPath)) {
            fs.writeFileSync(indexCssPath, TAILWIND_CSS_BASE);
            console.log(`[${path.basename(projectRoot)}] Created default index.css`);
        } else {
            // Repair existing index.css if @tailwind directives are missing
            const existing = fs.readFileSync(indexCssPath, 'utf-8');
            if (!existing.includes('@tailwind')) {
                fs.writeFileSync(indexCssPath, TAILWIND_CSS_BASE + existing);
                console.log(`[${path.basename(projectRoot)}] Repaired index.css (added @tailwind)`);
            }
        }
    }

    // Check if user provided App.tsx
    if (!userFilePaths.has('src/App.tsx') && !userFilePaths.has('src/App.jsx')) {
        // If no App provided, check if there's an alternative entry
        const hasIndex = userFilePaths.has('src/index.tsx') || userFilePaths.has('index.tsx');
        if (!hasIndex) {
            const appPath = path.join(projectRoot, 'src', 'App.tsx');
            if (!fs.existsSync(appPath)) {
                fs.writeFileSync(appPath, PLACEHOLDER_APP_TSX);
                console.log(`[${path.basename(projectRoot)}] Created default App.tsx`);
            }
        }
    }

    // If generated files import the shadcn dialog primitive but omit the file,
    // provide a minimal compatible fallback so preview builds don't fail.
    const importsDialog = userFiles.some((f) =>
        typeof f.content === 'string' && /@\/components\/ui\/dialog/.test(f.content)
    );
    if (importsDialog) {
        const dialogPath = path.join(projectRoot, 'src', 'components', 'ui', 'dialog.tsx');
        if (!fs.existsSync(dialogPath)) {
            const dialogDir = path.dirname(dialogPath);
            if (!fs.existsSync(dialogDir)) fs.mkdirSync(dialogDir, { recursive: true });
            fs.writeFileSync(dialogPath, `import * as React from 'react';

type DialogContextValue = {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
};

const DialogContext = React.createContext<DialogContextValue>({ open: true });

interface DialogProps {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
}

function Dialog({ open = true, onOpenChange, children }: DialogProps) {
    return <DialogContext.Provider value={{ open, onOpenChange }}>{children}</DialogContext.Provider>;
}

function DialogContent({ className = '', children }: { className?: string; children: React.ReactNode }) {
    const { open } = React.useContext(DialogContext);
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className={\`w-full max-w-lg rounded-lg bg-background p-6 shadow-xl \${className}\`.trim()}>{children}</div>
        </div>
    );
}

function DialogHeader({ className = '', children }: { className?: string; children: React.ReactNode }) {
    return <div className={\`mb-4 space-y-1 \${className}\`.trim()}>{children}</div>;
}

function DialogTitle({ className = '', children }: { className?: string; children: React.ReactNode }) {
    return <h2 className={\`text-lg font-semibold \${className}\`.trim()}>{children}</h2>;
}

function DialogDescription({ className = '', children }: { className?: string; children: React.ReactNode }) {
    return <p className={\`text-sm text-muted-foreground \${className}\`.trim()}>{children}</p>;
}

export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription };
`);
            console.log(`[${path.basename(projectRoot)}] Created fallback src/components/ui/dialog.tsx`);
        }
    }
}

// Returns true when a project directory contains only the blank scaffold written by
// initProject() — i.e. no real user-generated files exist yet (or were pruned).
function isScaffoldOnly(projectRoot) {
    const srcDir = path.join(projectRoot, 'src');
    if (!fs.existsSync(srcDir)) return true;
    const files = fs.readdirSync(srcDir);
    if (files.length > 3) return false;
    // initProject creates exactly: main.tsx, App.tsx, index.css
    const scaffoldNames = new Set(['main.tsx', 'App.tsx', 'index.css']);
    return files.every(f => scaffoldNames.has(f));
}

async function materializeProjectFiles(projectId, projectRoot, files, { dryRun = false, deferReload = false } = {}) {
    const userFilePaths = new Set(files.map((file) => file.path.replace(/^\/+/, '')));
    const allFixedIssues = [];
    const validationErrors = [];
    const preparedFiles = [];
    const binaryWroteFiles = [];
    const configFiles = new Set(['vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'package.json', 'postcss.config.js', 'tailwind.config.js', 'components.json']);
    // D-1 (sync-architecture audit, 2026-08-11): every file this call actually
    // materializes, {path, content}, in the exact final form written to disk
    // (post preprocess/repair for text files; the base64 payload as-is for
    // binary — re-encoding would be redundant, the base64 string IS the
    // content). Reduced to a single hash below and returned to the caller —
    // the first piece of data ANY caller can compare against its own record
    // of "what did I last push here." Nothing consumes this yet; that's D-2.
    const hashedFiles = [];

    // Known-good scaffold defaults for JSON config files
    const SCAFFOLD_JSON_DEFAULTS = {
        'tsconfig.json': JSON.stringify({
            compilerOptions: {
                target: 'ES2020', useDefineForClassFields: true,
                lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext',
                skipLibCheck: true, moduleResolution: 'bundler',
                allowImportingTsExtensions: true, resolveJsonModule: true,
                isolatedModules: true, noEmit: true, jsx: 'react-jsx',
                strict: true, noUnusedLocals: false, noUnusedParameters: false,
                noFallthroughCasesInSwitch: true, baseUrl: '.', paths: { '@/*': ['./src/*'] },
            },
            include: ['src'], references: [],
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

    for (const file of files) {
        if (file.content == null) {
            // `keep: true` entries are files the runner knows are unchanged and
            // already on disk: counted as user files (so pruning keeps them),
            // never written. Anything else without content is a caller bug.
            if (!file.keep) console.warn('[Materialize] Skipping file with null/undefined content:', file.path);
            continue;
        }
        const safePath = file.path.replace(/^\/+/, '');
        const filePath = path.join(projectRoot, safePath);

        // Security: reject any path that escapes the project root (path traversal).
        // path.join() alone does NOT prevent ../ sequences — must resolve & compare.
        const resolvedFilePath = path.resolve(filePath);
        const resolvedProjectRoot = path.resolve(projectRoot);
        if (!resolvedFilePath.startsWith(resolvedProjectRoot + path.sep) && resolvedFilePath !== resolvedProjectRoot) {
            console.warn(`[Security] Path traversal blocked: "${file.path}" resolved to "${resolvedFilePath}"`);
            continue;
        }

        // Security: block writes to sensitive directories that must never be
        // overwritten by agent-generated files.
        const topSegment = safePath.split('/')[0];
        if (['node_modules', '.deps', '.git', 'dist', '.cache', '.vite-cache', '.src-snapshot'].includes(topSegment)) {
            console.warn(`[Security] Write to protected directory blocked: "${safePath}"`);
            continue;
        }

        if (/\.json$/i.test(safePath) && !safePath.startsWith('node_modules')) {
            try {
                JSON.parse(file.content);
            } catch {
                const fallback = SCAFFOLD_JSON_DEFAULTS[safePath];
                if (fallback) {
                    console.warn(`[Materialize] ${safePath}: invalid JSON — replacing with scaffold default`);
                    file.content = fallback;
                    allFixedIssues.push(`${safePath}: Replaced corrupt JSON with scaffold default`);
                } else if (fs.existsSync(filePath)) {
                    // Keep existing file on disk rather than overwriting with garbage
                    console.warn(`[Materialize] ${safePath}: invalid JSON — keeping existing file`);
                    allFixedIssues.push(`${safePath}: Kept existing file (new content was invalid JSON)`);
                    continue;
                }
            }
        }
        const dir = path.dirname(filePath);
        if (!dryRun && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Binary files arrive as base64-encoded strings from the agent sync.
        // Decode and write them directly — no preprocessing or validation needed.
        if (file.content && file.content.startsWith('__SMEsAgent_BIN64__')) {
            hashedFiles.push({ path: safePath, content: file.content });
            if (!dryRun) {
                const buf = Buffer.from(file.content.slice('__SMEsAgent_BIN64__'.length), 'base64');
                fs.writeFileSync(filePath, buf);
                binaryWroteFiles.push(filePath);
            }
            continue;
        }

        // A binary-extension file WITHOUT the sentinel is a mangled push: a
        // caller read raw bytes as UTF-8 text (every non-UTF8 byte becomes
        // U+FFFD) and synced the soup. Writing it destroys the asset on disk
        // — confirmed live 2026-08-18: every project reload re-corrupted the
        // user's logo this way. Keep whatever is on disk instead.
        //
        // Council review 2026-08-18 caught the trap this created: silently
        // "keeping existing" PERMANENTLY PINS a file that was already
        // corrupt before this guard ever ran (from the same bug, in an
        // earlier push, before this fix existed) — no future good push can
        // land on it either. Check the existing file's own magic bytes; if
        // it's ALSO invalid, log distinctly so this is diagnosable and
        // repairable instead of silently permanent.
        if (/\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|otf|mp4|mp3|pdf|zip)$/i.test(safePath)) {
            hashedFiles.push({ path: safePath, content: file.content ?? '' });
            if (!dryRun) {
                const existingLooksValid = (() => {
                    try {
                        const head = fs.readFileSync(filePath).subarray(0, 8);
                        const MAGIC = [[0x89,0x50,0x4e,0x47],[0xff,0xd8,0xff],[0x47,0x49,0x46,0x38],[0x25,0x50,0x44,0x46],[0x50,0x4b,0x03,0x04],[0x00,0x00,0x01,0x00],[0x52,0x49,0x46,0x46]];
                        return MAGIC.some((m) => m.every((b, i) => head[i] === b));
                    } catch { return false; }
                })();
                if (existingLooksValid) {
                    console.warn(`[Materialize] ${safePath}: binary file pushed as mangled text — keeping valid existing file`);
                    allFixedIssues.push(`${safePath}: Kept existing file (binary content was text-mangled)`);
                } else {
                    console.error(`[Materialize] ${safePath}: PINNED-CORRUPT — pushed content is mangled AND the existing file on disk fails magic-byte check too. This asset is stuck broken until repaired from a known-good source.`);
                    allFixedIssues.push(`${safePath}: PINNED-CORRUPT — both pushed and on-disk content are invalid, needs manual repair`);
                }
            }
            continue;
        }

        // __edge_functions__/*.js mirrors (see write_edge_function.ts) are raw
        // sandbox function bodies — no imports, bare top-level statements,
        // undeclared free variables (secrets/params/db) injected by the runner.
        // They are NOT React/TS app code and must never go through preprocessFile
        // or validateSourceFile, both built for component files: doing so both
        // corrupted a function's syntax (the same false-positive "autoFix"
        // pattern seen on regular files) AND surfaced its "errors" as blocking
        // /status failures for the whole app, even though this directory is
        // never bundled or executed client-side at all.
        if (safePath.startsWith('__edge_functions__/')) {
            hashedFiles.push({ path: safePath, content: file.content });
            if (!dryRun) {
                fs.writeFileSync(filePath, file.content);
                binaryWroteFiles.push(filePath);
            }
            continue;
        }

        const { content: preprocessedContent, issues } = preprocessFile(safePath, file.content);
        allFixedIssues.push(...issues.map((issue) => `${safePath}: ${issue}`));

        let contentToWrite = preprocessedContent;
        if (safePath === 'index.html') {
            contentToWrite = contentToWrite
                .replace(/src="\/src\//g, 'src="./src/')
                .replace(/href="\/src\//g, 'href="./src/');
        }

        if (safePath === 'package.json') {
            contentToWrite = harmonizePackageJson(contentToWrite, files);
        }

        let fileValidationErrors = await validateSourceFile(safePath, contentToWrite);

        // Validation fallback: attempt one more surgical repair for malformed default
        // string parameters before declaring the file invalid.
        if (fileValidationErrors.length > 0 && /\.(tsx?|jsx?)$/.test(safePath)) {
            const repaired = repairMalformedDefaultStringParams(contentToWrite);
            if (repaired !== contentToWrite) {
                const repairedValidationErrors = await validateSourceFile(safePath, repaired);
                if (repairedValidationErrors.length === 0) {
                    contentToWrite = repaired;
                    allFixedIssues.push(`${safePath}: Fixed malformed default string parameter (validation fallback)`);
                    fileValidationErrors = [];
                }
            }
        }

        validationErrors.push(...fileValidationErrors);

        hashedFiles.push({ path: safePath, content: contentToWrite });
        preparedFiles.push({
            safePath,
            filePath,
            contentToWrite,
            shouldSkipWrite: configFiles.has(safePath) && fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf-8') === contentToWrite,
        });
    }

    if (allFixedIssues.length > 0) {
        const uniqueFilePaths = new Set(allFixedIssues.map((issue) => issue.split(':')[0])).size;
        const uniqueIssues = [...new Set(allFixedIssues)];
        const sample = uniqueIssues.slice(0, 6).join(' | ');
        console.log(
            `[Preprocess] Applied ${allFixedIssues.length} fix(es) across ${uniqueFilePaths} file(s)` +
            (sample ? `: ${sample}${uniqueIssues.length > 6 ? ' | ...' : ''}` : '')
        );
    }

    // Validation errors are treated as non-blocking warnings — files are written
    // and Vite HMR surfaces them as browser overlays, consistent with esbuild and
    // cross-file import handling. Hard-rejecting (422) blocks the AI agent loop.
    if (validationErrors.length > 0) {
        const sample = validationErrors.slice(0, 3).map((e) => e.summary).join(' | ');
        console.warn(`[Validate] ${validationErrors.length} warning(s) — writing files anyway: ${sample}`);
    }

    const wroteFiles = [...binaryWroteFiles];
    let shouldReload = false;
    if (!dryRun) {
        for (const prepared of preparedFiles) {
            if (prepared.shouldSkipWrite) {
                continue;
            }

            fs.writeFileSync(prepared.filePath, prepared.contentToWrite);
            wroteFiles.push(prepared.filePath);
        }

        const projectIdInstance = activeServers.get(projectId);
        if (projectIdInstance) {
            // Batch write complete: invalidate the whole module graph ONCE and send
            // a SINGLE full-reload to the browser (works for both a legacy
            // in-process instance and a child-process instance, see instanceOps.js).
            // Emitting one watcher 'change' event PER FILE caused N separate Vite HMR
            // processing cycles — each .tsx file without a self-accepting HMR boundary
            // triggered its own 'full-reload' WebSocket message (26 files = 26
            // 'page reload' log entries). The Vite client debounces but the module
            // graph ends in a partially-stale state causing cascading re-requests.
            //
            // But a full reload on EVERY agent response, for EVERY project, was
            // itself the wrong default: an agent very commonly writes files the
            // currently-viewed page hasn't imported yet (new components staged for
            // a later step, files behind a route the user isn't on) -- none of
            // that is visible, so reloading for it is pure disruption. Only
            // reload when at least one written file is actually part of the
            // browser's already-loaded module graph; a child-process instance's
            // Vite lives in a separate process with no graph to inspect here, so
            // it keeps the original always-reload behavior (confirmed live
            // 2026-08-19: reload-on-every-response reported across every project,
            // not one -- this is the shared cause).
            const touchesLoadedModule = isChildInstance(projectIdInstance)
                ? true
                : filesTouchLoadedModule(projectIdInstance.vite, wroteFiles);
            shouldReload = touchesLoadedModule;
            // options.deferReload (2026-08-19): the /update route's own build
            // check (quickViteBuildCheck) only runs AFTER this write, using the
            // files now on disk -- it can't gate a reload decision already made
            // in here. When set, this function still writes the files (the
            // agent's own diagnosis/fix tools need the real on-disk state to
            // work against) but leaves the actual browser-facing reload to the
            // caller, so a batch that just introduced a known build error never
            // replaces the last-good version the user is looking at. Without
            // this, a push that broke the app still went live immediately, and
            // only the SEPARATE error-status poll surfaced it after the fact --
            // "always show a stable version, never a broken one" requires
            // gating the reload itself, not just reporting on it afterward.
            if (deferReload) {
                if (!touchesLoadedModule) {
                    console.log(`[${projectId}] Skipped reload -- ${wroteFiles.length} file(s) written, none currently loaded by the browser`);
                }
            } else if (touchesLoadedModule) {
                sendFullReload(projectIdInstance, projectId);
            } else {
                console.log(`[${projectId}] Skipped reload -- ${wroteFiles.length} file(s) written, none currently loaded by the browser`);
            }
        }
    }
    // dryRun (used by /preview/:projectId/check): validation above already ran
    // in full against the same content; we just never touch disk or the live
    // Vite instance, so the user-visible preview stays untouched until the
    // real end-of-run /update push. See get_build_errors.ts.

    const contentHash = hashFileSet(hashedFiles);

    return { userFilePaths, allFixedIssues, validationErrors, wroteFiles, contentHash, shouldReload };
}

// Whether a full page reload is actually needed for a batch of written files
// (2026-08-19): a full-reload-on-every-push default meant an agent response
// that only touched files the currently-viewed page hasn't imported yet --
// new components staged for a later step, files behind a route the user
// isn't on -- still blew away the whole page for no visible change, on
// every project. `vite` is Vite's live in-process dev-server object (only
// available for a legacy, non-child-process instance; a child-process
// instance's Vite lives in another process with no graph to inspect here,
// so callers should treat that case as always-reload). Defaults to true
// (reload) whenever the check itself can't be trusted -- staying silently
// stale is worse than one unnecessary reload.
function filesTouchLoadedModule(vite, wroteFiles) {
    if (!vite?.moduleGraph?.getModulesByFile) return true;
    return wroteFiles.some((filePath) => {
        try {
            const mods = vite.moduleGraph.getModulesByFile(filePath);
            return Boolean(mods && mods.size > 0);
        } catch {
            return true;
        }
    });
}

// D-1: deterministic content hash over a {path, content}[] set, order-
// independent (sorted by path first) so the same file set hashes identically
// regardless of what order the caller's array happened to list them in.
// Path is included in each hashed segment, not just content, so a rename
// (same content, different path) still changes the hash.
function hashFileSet(files) {
    const hash = crypto.createHash('sha256');
    for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        hash.update(f.path);
        hash.update('\0');
        hash.update(f.content);
        hash.update('\0');
    }
    return hash.digest('hex');
}

// Binary-extension files are NEVER pruned, unconditionally -- no
// "incomplete set" heuristic to get wrong. pruneProjectFiles used to trust
// a client-supplied fullSync boolean with no floor check: a push claiming
// 12 files against 188 on disk deleted the other 176 and returned 200 OK.
// An orphaned stale logo costs nothing; a deleted one costs a customer
// (council review 2026-08-18: 5 confirmed root causes for "images
// disappear on reload" reduce to one missing invariant -- nothing in this
// system can tell a good file from a bad one, so nothing should ever
// destroy one on a guess).
const NEVER_PRUNE_EXT_RE = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|otf|mp4|mp3|pdf|zip|svg)$/i;

/** Count files a real fullSync would be expected to cover -- same walk/skip
 *  rules as pruneProjectFiles, used as the floor check before pruning. */
function countProjectFiles(projectRoot) {
    const protectedTopLevel = new Set(['node_modules', '.deps', '.vite-cache', '.git', '.cache', '.src-snapshot']);
    let count = 0;
    function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (protectedTopLevel.has(entry.name) && dir === projectRoot) continue;
            const absPath = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(absPath); continue; }
            count++;
        }
    }
    walk(projectRoot);
    return count;
}

// Floor check for the fullSync prune path (server.js's /sync-revision route):
// fullSync is a client-supplied boolean with no server-side verification
// that the push is actually complete. A caller that silently lost files (the
// 2026-08 incident: concurrent downloads failing quietly) believes it holds
// everything and asserts prune rights on a fraction of the real tree.
// Returns a skip reason string when prune should be refused, or undefined
// when it's safe to proceed. Pulled out as its own pure function (rather
// than left inline in the route) so the two guards are unit-testable without
// spinning up the express app.
function shouldSkipPrune(pushedFileCount, onDiskCount) {
    // Absolute guard, independent of project size: an empty/all-missing push
    // against a project that already has files on disk is never a
    // legitimate full sync.
    if (pushedFileCount === 0 && onDiskCount > 0) {
        return `push has ${pushedFileCount} files, disk has ${onDiskCount} -- push looks incomplete, not a real full sync`;
    }
    // Ratio guard: only applied above 10 files, where the ratio math is
    // stable -- below that, deleting most of a tiny project in one edit is
    // common and legitimate.
    const PRUNE_FLOOR_RATIO = 0.5;
    if (onDiskCount > 10 && pushedFileCount < onDiskCount * PRUNE_FLOOR_RATIO) {
        return `push has ${pushedFileCount} files, disk has ${onDiskCount} -- push looks incomplete, not a real full sync`;
    }
    return undefined;
}

function pruneProjectFiles(projectRoot, userFilePaths) {
    const removed = [];
    const protectedTopLevel = new Set(['node_modules', '.deps', '.vite-cache', '.git', '.cache', '.src-snapshot']);

    function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const absPath = path.join(dir, entry.name);
            const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');

            if (!relPath) continue;

            // Protect critical top-level paths whether they are real directories
            // OR symlinks (node_modules is always a symlink to the shared install).
            // Without this guard, fullSync pruning deleted the node_modules symlink,
            // causing Vite to fail resolving any import until the next initProject call.
            if (protectedTopLevel.has(relPath.split('/')[0])) continue;

            // .env.local (and any .env* file) is written by the /secrets endpoint,
            // NOT by the agent — it never appears in userFilePaths since the agent
            // doesn't "own" it. Without this guard, the very next fullSync (which
            // runs at the end of EVERY agent turn) deleted it as a "stale" file,
            // silently wiping VITE_DB_API_URL/VITE_SUPABASE_URL/etc. moments after
            // they were synced — the running Vite server kept them in memory until
            // its next restart, but any restart (secrets re-sync, redeploy, crash)
            // came back up with no env file at all ("Database API URL is not
            // configured" / import.meta.env.VITE_* all undefined).
            if (/^\.env(\..+)?$/.test(entry.name)) continue;

            // See NEVER_PRUNE_EXT_RE above.
            if (NEVER_PRUNE_EXT_RE.test(entry.name)) continue;

            if (entry.isDirectory()) {
                walk(absPath);
                try {
                    const remaining = fs.readdirSync(absPath);
                    if (remaining.length === 0) {
                        fs.rmSync(absPath, { recursive: true, force: true });
                    }
                } catch { /* dir may have been removed or repopulated */ }
                continue;
            }

            // Binary files now travel in the payload as base64, so they appear
            // in userFilePaths like any other file. The normal check below
            // handles pruning stale binaries correctly.
            if (!userFilePaths.has(relPath)) {
                try {
                    fs.rmSync(absPath, { force: true });
                    removed.push(relPath);
                } catch { /* file may be locked by Vite */ }
            }
        }
    }

    walk(projectRoot);
    return removed;
}

function collectReferencedPackages(files) {
    const referencedPackages = new Set();

    for (const file of files) {
        const safePath = file.path.replace(/^\/+/, '');
        if (!/\.(tsx?|jsx?)$/.test(safePath)) {
            continue;
        }

        const importMatches = file.content.matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g);
        for (const match of importMatches) {
            const specifier = match[1] || match[2];
            if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) {
                continue;
            }

            if (specifier.startsWith('@')) {
                const scoped = specifier.split('/').slice(0, 2).join('/');
                referencedPackages.add(scoped);
                continue;
            }

            referencedPackages.add(specifier.split('/')[0]);
        }
    }

    return referencedPackages;
}

function harmonizePackageJson(packageJsonContent, files) {
    try {
        const parsed = JSON.parse(packageJsonContent);
        const referencedPackages = collectReferencedPackages(files);
        if (referencedPackages.size === 0) {
            return packageJsonContent;
        }

        const previewPackageJsonPath = path.join(__dirname, '..', 'package.json');
        const previewPackageJson = JSON.parse(fs.readFileSync(previewPackageJsonPath, 'utf-8'));
        const availableDeps = {
            ...(previewPackageJson.dependencies || {}),
            ...(previewPackageJson.devDependencies || {}),
        };

        parsed.dependencies = parsed.dependencies || {};

        for (const pkg of referencedPackages) {
            if (!parsed.dependencies[pkg] && availableDeps[pkg]) {
                parsed.dependencies[pkg] = availableDeps[pkg];
            }
        }

        return JSON.stringify(parsed, null, 2);
    } catch (error) {
        console.warn('Failed to harmonize package.json:', error);
        return packageJsonContent;
    }
}

/**
 * True when an incoming package.json asks for a dependency the on-disk copy
 * doesn't already satisfy -- the only condition that actually warrants a Vite
 * restart.
 *
 * Lives next to harmonizePackageJson because it exists to compensate for it:
 * what lands on disk is harmonizePackageJson(preprocess(incoming)), which
 * INJECTS preview-provided deps for every package the source imports and
 * re-serialises with 2-space indent. Disk is therefore a superset of incoming
 * by construction, so the byte compare this replaced was always true --
 * 218 of 256 updates (85%) took a needless Vite restart plus a 22MB
 * .vite-cache wipe and a cold dependency pre-bundle (measured 2026-08-16),
 * the single largest source of slow preview updates. Comparing dependency
 * sets keeps this correct even if the write pipeline gains another
 * normalisation step later.
 */
function packageJsonNeedsRestart(diskContent, incomingContent) {
    const disk = JSON.parse(diskContent);
    const incoming = JSON.parse(incomingContent);
    const asksForSomethingNew = (incomingDeps, diskDeps) =>
        Object.entries(incomingDeps || {}).some(([name, version]) => (diskDeps || {})[name] !== version);
    return asksForSomethingNew(incoming.dependencies, disk.dependencies)
        || asksForSomethingNew(incoming.devDependencies, disk.devDependencies);
}

module.exports = {
    TAILWIND_CSS_BASE,
    ERROR_BOUNDARY_TSX,
    ensureErrorBoundaryWrap,
    preprocessFile,
    ensureEssentialFiles,
    isScaffoldOnly,
    materializeProjectFiles,
    pruneProjectFiles,
    countProjectFiles,
    shouldSkipPrune,
    collectReferencedPackages,
    harmonizePackageJson,
    packageJsonNeedsRestart,
    filesTouchLoadedModule,
};
