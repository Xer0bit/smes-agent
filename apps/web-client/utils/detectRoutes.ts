/**
 * Parses a generated project's src/App.tsx for declared <Route> entries.
 * Every generated app uses HashRouter with routes written as
 * <Route path="/product/:id" element={<ProductDetails />} />   this is a
 * regex extraction (matches the same style already used for symbol/import
 * graph parsing elsewhere in this codebase), not a full AST parse.
 */
export interface DetectedRoute {
  path: string;
  component: string;
  isDynamic: boolean;
}

const ROUTE_RE = /<Route\s+[^>]*path=["']([^"']+)["'][^>]*element=\{<(\w+)/g;

export function detectRoutesFromAppTsx(appTsxContent: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  ROUTE_RE.lastIndex = 0;
  while ((match = ROUTE_RE.exec(appTsxContent)) !== null) {
    const [, path, component] = match;
    if (seen.has(path)) continue;
    seen.add(path);
    routes.push({ path, component, isDynamic: path.includes(':') });
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}
