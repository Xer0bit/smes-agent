/**
 * File Validation Service
 * Pre-validates and auto-fixes common issues in generated files before preview build
 */

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  fixedFiles: FileWithFixes[];
}

export interface ValidationError {
  file: string;
  line?: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationWarning {
  file: string;
  message: string;
}

export interface FileWithFixes {
  path: string;
  content: string;
  originalContent: string;
  fixes: string[];
}

export interface WorkspaceFile {
  path: string;
  content: string;
}

function normalizeWorkspacePath(filePath: string): string {
  return filePath.replace(/^\/+/, '').replace(/\\/g, '/');
}

function getCriticalFileFallback(filePath: string): string | null {
  const normalized = normalizeWorkspacePath(filePath);

  if (normalized === 'postcss.config.js') {
    return `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;
  }

  if (normalized === 'tailwind.config.js') {
    return `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [require('tailwindcss-animate')],
};
`;
  }

  if (normalized === 'vite.config.ts') {
    return `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
`;
  }

  if (normalized === 'src/main.tsx') {
    return `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`;
  }

  if (normalized === 'src/lib/utils.ts') {
    return `import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;
  }

  if (normalized === 'tsconfig.node.json') {
    return JSON.stringify({
      compilerOptions: {
        composite: true,
        skipLibCheck: true,
        module: 'ESNext',
        moduleResolution: 'bundler',
        allowSyntheticDefaultImports: true,
        strict: true,
        noEmit: true,
      },
      include: ['vite.config.ts'],
    }, null, 2);
  }

  if (normalized === 'tsconfig.json') {
    return JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        useDefineForClassFields: true,
        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        skipLibCheck: true,
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: 'react-jsx',
        strict: false,
        baseUrl: '.',
        paths: { '@/*': ['./src/*'] },
      },
      include: ['src'],
    }, null, 2);
  }

  return null;
}

/**
 * Validate and auto-fix a collection of workspace files
 */
export function validateAndFixFiles(files: WorkspaceFile[]): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const fixedFiles: FileWithFixes[] = [];

  for (const file of files) {
    const result = validateAndFixFile(file);
    
    if (result.fixes.length > 0) {
      fixedFiles.push(result);
    }
    
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  // Check for essential files
  const filePaths = new Set(files.map(f => f.path.replace(/^\//, '')));
  
  if (!filePaths.has('src/App.tsx') && !filePaths.has('src/App.jsx') && !filePaths.has('App.tsx')) {
    warnings.push({
      file: 'project',
      message: 'No App.tsx found - a default will be created'
    });
  }

  if (!filePaths.has('src/main.tsx') && !filePaths.has('src/main.jsx')) {
    warnings.push({
      file: 'project',
      message: 'No main.tsx found - a default will be created'
    });
  }

  // Check for common missing dependencies in imports
  const allContent = files.map(f => f.content).join('\n');
  checkCommonDependencies(allContent, warnings);

  return {
    isValid: errors.filter(e => e.severity === 'error').length === 0,
    errors,
    warnings,
    fixedFiles
  };
}

function validateAndFixFile(file: WorkspaceFile): FileWithFixes & { errors: ValidationError[]; warnings: ValidationWarning[] } {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const fixes: string[] = [];
  let content = file.content;
  const originalContent = file.content;
  const normalizedPath = normalizeWorkspacePath(file.path);

  // ── JSON file validation ────────────────────────────────────────────────────
  // Validate all .json files contain valid JSON. If corrupt, use scaffold default.
  if (/\.json$/i.test(normalizedPath)) {
    try {
      JSON.parse(content);
    } catch {
      const fallback = getCriticalFileFallback(normalizedPath);
      if (fallback) {
        content = fallback;
        fixes.push(`Replaced corrupt ${normalizedPath} (invalid JSON) with scaffold default`);
      } else {
        errors.push({ file: file.path, message: `${normalizedPath} contains invalid JSON`, severity: 'error' });
      }
    }
    return { path: file.path, content, originalContent, fixes, errors, warnings };
  }

  if (file.path.match(/\.css$/)) {
    const isIndexCss =
      normalizedPath === 'src/index.css' ||
      normalizedPath.endsWith('/src/index.css') ||
      normalizedPath === 'index.css';

    if (isIndexCss) {
      const before = content;
      const cssFixes = [
        [
          /@apply\s+(?=[^;]*bg-gradient-to-br)(?=[^;]*from-slate-50)(?=[^;]*via-blue-50)(?=[^;]*to-purple-50)(?=[^;]*text-foreground)(?=[^;]*min-h-screen)[^;]*;/g,
          'background-image: linear-gradient(135deg, #f8fafc 0%, #eff6ff 48%, #f5f3ff 100%); color: hsl(var(--foreground, 222.2 84% 4.9%)); min-height: 100vh;',
        ],
        [/@apply\s+border-border\s*;/g, 'border-color: hsl(var(--border, 214.3 31.8% 91.4%));'],
        [/@apply\s+bg-background\s+text-foreground\s*;/g, 'background-color: hsl(var(--background, 0 0% 100%)); color: hsl(var(--foreground, 222.2 84% 4.9%));'],
        [/@apply\s+bg-background\s*;/g, 'background-color: hsl(var(--background, 0 0% 100%));'],
        [/@apply\s+text-foreground\s*;/g, 'color: hsl(var(--foreground, 222.2 84% 4.9%));'],
      ] as const;

      for (const [pattern, replacement] of cssFixes) {
        if (pattern.test(content)) {
          content = content.replace(pattern, replacement);
        }
      }

      if (content !== before) {
        fixes.push('Replaced invalid CSS @apply utilities with plain CSS');
      }
    }

    return { path: file.path, content, originalContent, fixes, errors, warnings };
  }

  // Only validate/fix TypeScript/JavaScript files
  if (!file.path.match(/\.(tsx?|jsx?)$/)) {
    return { path: file.path, content, originalContent, fixes, errors, warnings };
  }

  // Fix 0: Sometimes the agent writes a full HTML document into a TSX/JSX file
  // (for example, <!doctype html> in src/App.tsx). Rewrite to a safe React
  // component so preview builds remain stable.
  const looksLikeHtmlDocument =
    /<!doctype\s+html/i.test(content) ||
    /<html[\s>]/i.test(content) ||
    /<head[\s>]/i.test(content) ||
    /<body[\s>]/i.test(content);

  if (looksLikeHtmlDocument) {
    const prettyName = file.path.split('/').pop()?.replace(/\.(tsx?|jsx?)$/i, '') || 'Component';
    content = `export default function ${prettyName.replace(/[^A-Za-z0-9_$]/g, '') || 'RecoveredComponent'}() {
  return (
    <main style={{ padding: '24px', fontFamily: 'system-ui', color: '#ddd', background: '#111', minHeight: '100vh' }}>
      <h1 style={{ fontSize: '20px', marginBottom: '12px' }}>Recovered preview component</h1>
      <p style={{ opacity: 0.8 }}>
        A full HTML document was generated for this TSX/JSX file and was auto-replaced to keep the preview stable.
      </p>
    </main>
  );
}
`;
    fixes.push('Replaced HTML document content with safe React component');
  }

  // Fix 0b: Sometimes corrupt revision data stores config/markdown content
  // (e.g. .env.example content) inside a .tsx/.jsx file. Detect and replace.
  const looksLikeNonCode =
    /^#\s/m.test(content.trimStart()) && !content.includes('import ') && !content.includes('export ');

  if (looksLikeNonCode) {
    const prettyName = file.path.split('/').pop()?.replace(/\.(tsx?|jsx?)$/i, '') || 'Component';
    content = `export default function ${prettyName.replace(/[^A-Za-z0-9_$]/g, '') || 'RecoveredComponent'}() {
  return (
    <main style={{ padding: '24px', fontFamily: 'system-ui', color: '#ddd', background: '#111', minHeight: '100vh' }}>
      <h1 style={{ fontSize: '20px', marginBottom: '12px' }}>Recovered preview component</h1>
      <p style={{ opacity: 0.8 }}>
        Non-code content was detected in this source file and was auto-replaced to keep the preview stable.
      </p>
    </main>
  );
}
`;
    fixes.push('Replaced non-code content (config/markdown) with safe React component');
  }

  // Fix 1: Remove .tsx/.ts/.jsx/.js extensions from imports
  const extPatterns = [
    { pattern: /from\s+['"]([^'"]+)\.tsx['"]/g, ext: '.tsx' },
    { pattern: /from\s+['"]([^'"]+)\.ts['"]/g, ext: '.ts' },
    { pattern: /from\s+['"]([^'"]+)\.jsx['"]/g, ext: '.jsx' },
    { pattern: /from\s+['"]([^'"]+)\.js['"]/g, ext: '.js' },
  ];
  
  for (const { pattern, ext } of extPatterns) {
    if (pattern.test(content)) {
      content = content.replace(new RegExp(pattern.source, 'g'), 'from "$1"');
      fixes.push(`Removed ${ext} extension from imports`);
    }
  }

  // Fix 2: Fix class= to className=
  if (/ class=/i.test(content)) {
    content = content.replace(/ class=/gi, ' className=');
    fixes.push('Fixed class -> className');
  }

  // Fix 3: Fix onclick, onchange, etc.
  const eventFixes = [
    { from: / onclick=/gi, to: ' onClick=' },
    { from: / onchange=/gi, to: ' onChange=' },
    { from: / onsubmit=/gi, to: ' onSubmit=' },
    { from: / onfocus=/gi, to: ' onFocus=' },
    { from: / onblur=/gi, to: ' onBlur=' },
    { from: / onkeydown=/gi, to: ' onKeyDown=' },
    { from: / onkeyup=/gi, to: ' onKeyUp=' },
  ];

  for (const { from, to } of eventFixes) {
    if (from.test(content)) {
      content = content.replace(from, to);
      fixes.push(`Fixed ${from.source.trim()} -> ${to.trim()}`);
    }
  }

  // Fix 3.5: Convert BrowserRouter → HashRouter (works in preview without basename config)
  if (content.includes('BrowserRouter')) {
    const before = content;
    // Step 1: repair missing space (e.g. <BrowserRouterbasename= → <BrowserRouter basename=)
    content = content.replace(/<BrowserRouter([a-z])/g, '<BrowserRouter $1');
    // Step 2: replace all BrowserRouter identifiers with HashRouter
    content = content.replace(/\bBrowserRouter\b/g, 'HashRouter');
    // Step 3: strip any basename prop from the resulting HashRouter tag
    content = content.replace(/<HashRouter([^>]*)\bbasename=(?:\{[^}]*\}|"[^"]*"|'[^']*')([^>]*)>/g, (m, pre, post) => {
      const attrs = (pre + post).trim();
      return attrs ? `<HashRouter ${attrs}>` : '<HashRouter>';
    });
    if (content !== before) {
      fixes.push('Converted BrowserRouter → HashRouter');
    }
  }

  // Fix 3.6: Replace escaped quotes inside className strings (e.g., data URLs)
  if (/className="[^"]*\\"/.test(content)) {
    const before = content;
    content = content.replace(/className="([^"]*)"/g, (match, value) => {
      const replaced = value.replace(/\\"/g, '&quot;');
      return `className="${replaced}"`;
    });
    if (content !== before) {
      fixes.push('Replaced escaped quotes inside className');
    }
  }

  // Fix 3.65: Repair malformed empty-string object values (e.g. email: ', subject: ')
  // Scope this fix to object-property assignments only so valid string literals
  // like console.error('Error: ', err) are not modified.
  const malformedPropEmptyStringPattern = /([,{]\s*(?:[A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*)'\s*(?=[,}])/g;
  const malformedPropEmptyDoublePattern = /([,{]\s*(?:[A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*)"\s*(?=[,}])/g;
  const malformedPropSmartQuotePattern = /([,{]\s*(?:[A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*)[‘’]\s*(?=[,}])/g;

  if (
    malformedPropEmptyStringPattern.test(content) ||
    malformedPropEmptyDoublePattern.test(content) ||
    malformedPropSmartQuotePattern.test(content)
  ) {
    const before = content;
    content = content
      .replace(malformedPropEmptyStringPattern, "$1''")
      .replace(malformedPropEmptyDoublePattern, '$1""')
      .replace(malformedPropSmartQuotePattern, "$1''");
    if (content !== before) {
      fixes.push('Repaired malformed empty-string object values');
    }
  }

  // Fix 3.7: Wrap return JSX in fragment if multiple root blocks are detected
  //
  // Two real bugs here (confirmed live: broke a valid, single-root-element
  // SocialMedia.tsx): (1) hasMultipleRoots pattern-matches "closing tag then
  // opening tag on the next line" ANYWHERE in the file, which is also just
  // what ordinary NESTED sibling JSX looks like   not proof of multiple root
  // elements. (2) the closing-tag insertion only matched a `)` sitting at the
  // literal end of the whole file, which is never true for a component whose
  // return lives inside a function body (always followed by a trailing `}`)
  // so `<>` got inserted unconditionally while `</>` silently never did,
  // leaving unbalanced JSX ("Unterminated JSX contents"). Fix: require the
  // closing pattern to actually match before mutating anything, so the two
  // edits are atomic   never one without the other.
  if (/return\s*\(/.test(content)) {
    const hasMultipleRoots = /\n\s*<\/\w+[^>]*>\s*\n\s*(?:<|\{\/\*)/.test(content);
    const closingPattern = /\n\s*\)\s*;?\s*$/;
    if (hasMultipleRoots && !/return\s*\(\s*<>/.test(content) && closingPattern.test(content)) {
      const before = content;
      content = content.replace(/return\s*\(\s*\n/, 'return (\n    <>\n');
      content = content.replace(closingPattern, '\n    </>\n  )');
      if (content !== before) {
        fixes.push('Wrapped return JSX in fragment');
      }
    }
  }

  // Fix 4: Handle import.meta.env safely
  if (/import\.meta\.env\.[A-Z_]+/.test(content)) {
    // Replace with empty string or undefined for optional env vars
    content = content.replace(/import\.meta\.env\.([A-Z_]+)/g, (match, varName) => {
      // Common env vars that should have fallbacks
      if (varName === 'BASE_URL') return "'/'"; // HashRouter used instead of BrowserRouter
      if (varName === 'DEV') return 'true';
      if (varName === 'PROD') return 'false';
      if (varName === 'MODE') return '"development"';
      return 'undefined';
    });
    fixes.push('Replaced import.meta.env with safe fallbacks');
  }

  // Fix 5: Deterministically strip trailing orphan closer lines.
  // Truncation artifacts often append standalone lines like ")" or "}" at EOF
  // with no matching opener   but a NORMAL, complete file also ends in lines
  // like "  );" and "}" (any multi-line component's return/function close).
  // Without a balance check this stripped the closing lines off every valid
  // file shaped that way (confirmed live: a correct SocialMedia.tsx ending in
  // "</div>\n  );\n}" had both "  );" and "}" removed, leaving a dangling
  // "</div>" and a real parse error). Only remove while doing so does not
  // increase the paren/brace/bracket imbalance, mirroring preview-service's
  // own trimTrailingOrphanClosers (lib/validation.js), which has this guard.
  const orphanCloserLine = /^\s*[)}\];,]+\s*$/;
  const blankLine = /^\s*$/;
  const imbalanceScore = (text: string) => {
    let paren = 0, brace = 0, bracket = 0;
    for (const ch of text) {
      if (ch === '(') paren++; else if (ch === ')') paren--;
      else if (ch === '{') brace++; else if (ch === '}') brace--;
      else if (ch === '[') bracket++; else if (ch === ']') bracket--;
    }
    return Math.abs(paren) + Math.abs(brace) + Math.abs(bracket);
  };
  const lines = content.split('\n');
  let end = lines.length - 1;
  let removed = 0;
  let currentScore = imbalanceScore(content);

  while (end >= 0 && blankLine.test(lines[end] ?? '')) {
    end -= 1;
  }

  while (end >= 0 && orphanCloserLine.test(lines[end] ?? '')) {
    const candidateEnd = end - 1;
    const candidateText = lines.slice(0, candidateEnd + 1).join('\n');
    const candidateScore = imbalanceScore(candidateText);
    if (candidateScore > currentScore) break;
    end = candidateEnd;
    currentScore = candidateScore;
    removed += 1;
    while (end >= 0 && blankLine.test(lines[end] ?? '')) {
      end -= 1;
    }
  }

  if (removed > 0) {
    content = lines.slice(0, end + 1).join('\n');
    fixes.push(`Removed ${removed} trailing orphan closer line(s)`);
  }

  // Check for syntax errors (basic checks)
  checkBasicSyntax(file.path, content, errors);

  // Fix 6: If main.tsx has syntax errors (e.g. truncated by LLM), replace with
  // known-good fallback so the preview can boot. This catches the common case
  // where the agent streams a partial main.tsx missing the closing `)` of render().
  if (errors.some(e => e.severity === 'error') && normalizedPath === 'src/main.tsx') {
    const mainFallback = getCriticalFileFallback('src/main.tsx');
    if (mainFallback) {
      content = mainFallback;
      fixes.push('Replaced truncated main.tsx with working fallback');
      errors.length = 0;
    }
  }

  // Fix 6b: For other critical infrastructure files with known fallbacks, replace
  if (errors.some(e => e.severity === 'error')) {
    const knownFallback = getCriticalFileFallback(normalizedPath);
    if (knownFallback) {
      content = knownFallback;
      fixes.push(`Replaced broken ${normalizedPath} with scaffold fallback`);
      errors.length = 0;
    }
  }

  // Leave remaining hard errors intact so the preview orchestration can
  // rollback to the last good snapshot or surface a real failure state.

  // Check for potential issues
  checkPotentialIssues(file.path, content, warnings);

  return { path: file.path, content, originalContent, fixes, errors, warnings };
}

function checkBasicSyntax(filePath: string, content: string, errors: ValidationError[]) {
  // Check for unmatched brackets/braces
  let braceCount = 0;
  let bracketCount = 0;
  let parenCount = 0;
  let lineNumber = 1;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '\n') lineNumber++;

    // Skip // line comments and /* */ block comments   the comment above
    // this function has always claimed to do this, but never actually did:
    // only string literals were skipped. A stray apostrophe in a comment
    // ("the portal's real...") was treated as opening a string, silently
    // swallowing everything up to the next unrelated single-quote elsewhere
    // in the file (including its real braces) into the "skipped" region and
    // producing a false "unmatched bracket" error   confirmed live on
    // agent-template's own DashboardPage.tsx, a genuinely valid file.
    if (char === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
        if (content[i] === '\n') lineNumber++;
        i++;
      }
      i++; // land on the trailing '/', loop's i++ moves past it
      continue;
    }

    // Skip strings (basic check)
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === '\\') i++; // Skip escaped chars
        if (content[i] === '\n') lineNumber++;
        i++;
      }
      continue;
    }

    if (char === '{') braceCount++;
    if (char === '}') braceCount--;
    if (char === '[') bracketCount++;
    if (char === ']') bracketCount--;
    if (char === '(') parenCount++;
    if (char === ')') parenCount--;

    if (braceCount < 0 || bracketCount < 0 || parenCount < 0) {
      errors.push({
        file: filePath,
        line: lineNumber,
        message: 'Unmatched closing bracket/brace/parenthesis',
        severity: 'error'
      });
      break;
    }
  }

  if (braceCount !== 0 || bracketCount !== 0 || parenCount !== 0) {
    errors.push({
      file: filePath,
      message: 'Unmatched opening bracket/brace/parenthesis - check your code for missing closures',
      severity: 'error'
    });
  }
}

function checkPotentialIssues(filePath: string, content: string, warnings: ValidationWarning[]) {
  // Check for console.log statements (may cause issues in production)
  if (/console\.log\(/.test(content)) {
    warnings.push({
      file: filePath,
      message: 'Contains console.log statements'
    });
  }

  // Check for TODO comments
  if (/\/\/\s*TODO/i.test(content)) {
    warnings.push({
      file: filePath,
      message: 'Contains TODO comments'
    });
  }

  // Check for empty components
  if (/return\s*\(\s*\)/.test(content) || /return\s*null\s*;/.test(content)) {
    warnings.push({
      file: filePath,
      message: 'Component may return empty/null'
    });
  }
}

function checkCommonDependencies(content: string, warnings: ValidationWarning[]) {
  // Check for imports that may need special handling
  const potentialIssues = [
    { import: 'axios', message: 'Using axios - ensure API calls work in preview' },
    { import: 'firebase', message: 'Using Firebase - may not work in sandboxed preview' },
    { import: '@tanstack/react-query', message: 'Using React Query - needs QueryClient setup' },
    { import: 'zustand', message: 'Using Zustand - state will reset on preview refresh' },
  ];

  for (const { import: importName, message } of potentialIssues) {
    if (content.includes(`from '${importName}'`) || content.includes(`from "${importName}"`)) {
      warnings.push({
        file: 'dependencies',
        message
      });
    }
  }
}

/**
 * Get the fixed content for a file if fixes were applied
 */
export function getFixedContent(files: WorkspaceFile[]): WorkspaceFile[] {
  const result = validateAndFixFiles(files);
  
  // Create a map of fixed files
  const fixedMap = new Map(result.fixedFiles.map(f => [f.path, f.content]));
  
  // Return files with fixes applied
  return files.map(file => ({
    path: file.path,
    content: fixedMap.get(file.path) ?? file.content
  }));
}

/**
 * Quick check if files have any critical issues
 */
export function hasBlockingErrors(files: WorkspaceFile[]): boolean {
  const result = validateAndFixFiles(files);
  return result.errors.some(e => e.severity === 'error');
}
