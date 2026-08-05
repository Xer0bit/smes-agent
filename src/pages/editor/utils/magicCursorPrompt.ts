import type { MagicCursorTarget } from "../types";
import { extractJsxSnippet } from "./jsxSnippet";

// Turns 1+ selected elements + the user's free-text instruction into a
// single, source-addressed prompt: exact file, exact line range, exact
// source text per region, so the agent can go straight to `edit_file`
// instead of having to re-locate the target from a natural-language
// description across the whole project.
export function buildMagicCursorPrompt(
  targets: MagicCursorTarget[],
  userInstruction: string,
  getFileContent: (path: string) => string | undefined
): string {
  const regions = targets.map((target, i) => {
    if (!target.source) {
      // No resolvable source (e.g. plain HTML shell, not a React-owned
      // node) -- fall back to the old selector/tagName description so the
      // request still carries *some* precise address instead of failing.
      return `--- REGION ${i + 1} (selector-only, source unresolved) ---
Selector: ${target.selector}
Tag: <${target.tagName}>${target.text ? `\nText: "${target.text}"` : ''}
--- END REGION ${i + 1} ---`;
    }

    const { file, line, componentName, isComponentRoot } = target.source;
    const content = getFileContent(file);
    if (!content) {
      return `--- REGION ${i + 1} ---
File: ${file}
Line: ${line}
Component: ${componentName ?? 'unknown'}
(source not loaded client-side -- read this file first)
--- END REGION ${i + 1} ---`;
    }

    const { startLine, endLine, snippet } = extractJsxSnippet(content, line);
    return `--- REGION ${i + 1} ---
File: ${file}
Lines: ${startLine}-${endLine}
Component: ${componentName ?? 'unknown'}${isComponentRoot ? ' (this is the component\'s top-level return)' : ''}
Source:
${snippet}
--- END REGION ${i + 1} ---`;
  });

  const multi = targets.length > 1;

  return `You are editing SPECIFIC, PRE-SELECTED code region${multi ? 's' : ''} the user picked visually in the live preview. Do not modify anything outside the region${multi ? 's' : ''} below, even if the instruction implies broader impact -- if a change outside the region${multi ? 's' : ''} seems necessary, say so explicitly and stop instead of making it. Do not reformat or rewrite untouched lines, including ones adjacent to your edit.

${regions.join('\n\n')}

User instruction: "${userInstruction}"

Use edit_file (SEARCH/REPLACE) for each region that needs a change -- the SEARCH block must match the region's source above exactly. Only use write_file if the edit necessarily changes the component's own boundaries (e.g. splitting it into two components), and say so before doing it.${multi ? ' If multiple regions need changes, make one edit_file call per region.' : ''}`;
}
