import path from 'node:path';

/**
 * Deterministically derive a route path from a page component name, matching
 * the naming convention already documented in app-builder.prompt.ts:
 *   HomePage       → "/"        (home is ALWAYS "/" per prompt rule)
 *   AboutPage      → "/about"
 *   ContactUsPage  → "/contact-us"
 *   PricingPage    → "/pricing"
 */
export function deriveRoutePath(componentName: string): string {
  const base = componentName.replace(/Page$/, '');
  if (/^(home|index|landing)$/i.test(base) || base === '') return '/';
  // PascalCase / camelCase → kebab-case
  const kebab = base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
  return `/${kebab}`;
}

/**
 * Deterministic codegen replacement for the LLM-based "App.tsx fix pass".
 * Given the list of page files on disk, generates a complete src/App.tsx
 * with HashRouter + a Route per page   zero LLM calls, zero wiring failures.
 * Mirrors exactly the rules the old LLM prompt enforced (HashRouter only,
 * home page at "/", default export name === file basename).
 */
export function generateAppTsxFromPages(pagePaths: string[]): string {
  const pages = pagePaths.map(p => {
    const componentName = path.basename(p, path.extname(p));
    return { componentName, importPath: `./pages/${componentName}`, route: deriveRoutePath(componentName) };
  });

  // Two page filenames that derive to the same route (e.g. "ContactUsPage"
  // and "Contact-UsPage") would otherwise silently shadow each other  the
  // second <Route> in JSX order always wins, and the first page becomes
  // unreachable with no error anywhere. Fail loudly instead: the caller
  // (agentLoopService.ts) already treats this as non-fatal and leaves the
  // previous App.tsx in place, which beats generating a broken router.
  const byRoute = new Map<string, string[]>();
  for (const p of pages) {
    const names = byRoute.get(p.route) ?? [];
    names.push(p.componentName);
    byRoute.set(p.route, names);
  }
  const collisions = Array.from(byRoute.entries()).filter(([, names]) => names.length > 1);
  if (collisions.length > 0) {
    const detail = collisions.map(([route, names]) => `"${route}" (${names.join(', ')})`).join('; ');
    throw new Error(`generateAppTsxFromPages: duplicate route(s) ${detail}  rename one of the colliding pages.`);
  }

  // Home page ("/") must be listed first for readability; stable sort keeps
  // the rest in their original (disk-read) order.
  pages.sort((a, b) => (a.route === '/' ? -1 : b.route === '/' ? 1 : 0));

  const imports = pages.map(p => `import ${p.componentName} from "${p.importPath}";`).join('\n');
  const routes = pages.map(p => `        <Route path="${p.route}" element={<${p.componentName} />} />`).join('\n');

  return `import { HashRouter, Routes, Route } from "react-router-dom";
${imports}

export default function App() {
  return (
    <HashRouter>
      <Routes>
${routes}
      </Routes>
    </HashRouter>
  );
}
`;
}

/**
 * Given a file's content before and after a successful repair, extract the
 * minimal changed region as a SEARCH/REPLACE block for failure-memory storage.
 * Returns null when the change is too large/sprawling to be a useful template
 * for a DIFFERENT file's content (e.g. a full-file rewrite)   only tight,
 * localized fixes are worth remembering as a reusable diff.
 */
export function buildMinimalSearchReplace(before: string, after: string): string | null {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start++;

  let endB = beforeLines.length - 1;
  let endA = afterLines.length - 1;
  while (endB >= start && endA >= start && beforeLines[endB] === afterLines[endA]) { endB--; endA--; }

  const searchLines = beforeLines.slice(start, endB + 1);
  const replaceLines = afterLines.slice(start, endA + 1);

  // Reject sprawling changes   not a reusable template, and too large to be
  // worth matching verbatim against a different file's content later.
  if (searchLines.length === 0 || searchLines.length > 15 || replaceLines.length > 15) return null;

  const searchText = searchLines.join('\n');
  const replaceText = replaceLines.join('\n');
  return `<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`;
}
