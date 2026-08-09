export type BuilderTab = 'brief' | 'generate' | 'code' | 'preview' | 'revisions' | 'publish';

// One selected element from the preview's Magic Cursor inspector. `source`
// is null when the clicked DOM node couldn't be resolved to a React Fiber
// (e.g. a plain HTML shell element) -- callers should fall back to the CSS
// selector/tagName description in that case.
export interface MagicCursorTarget {
  selector: string;
  tagName: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  style: { color?: string; backgroundColor?: string; fontSize?: string };
  source: {
    file: string;
    line: number;
    column: number;
    componentName: string | null;
    isComponentRoot: boolean;
  } | null;
}
