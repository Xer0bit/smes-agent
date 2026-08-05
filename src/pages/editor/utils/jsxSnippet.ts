// Extracts the JSX subtree starting at a given 1-indexed source line, using
// a simple tag-depth counter (not a full parser -- reliable enough for
// consistently-formatted generated code; the caller can always fall back to
// a fixed window around the line if the result looks wrong).
export function extractJsxSnippet(
  content: string,
  line1: number,
  maxLines = 80
): { startLine: number; endLine: number; snippet: string } {
  const lines = content.split('\n');
  const startIdx = Math.max(0, Math.min(lines.length - 1, line1 - 1));

  const tagOpenRe = /<([A-Za-z][\w.]*)(?![\w])[^>]*?(\/?)>/g;
  const tagCloseRe = /<\/([A-Za-z][\w.]*)>/g;

  let depth = 0;
  let started = false;
  let endIdx = startIdx;

  for (let i = startIdx; i < Math.min(lines.length, startIdx + maxLines); i++) {
    const lineText = lines[i];
    const tokens: Array<{ idx: number; kind: 'open' | 'close' | 'selfclose' }> = [];

    let m: RegExpExecArray | null;
    tagOpenRe.lastIndex = 0;
    while ((m = tagOpenRe.exec(lineText))) {
      tokens.push({ idx: m.index, kind: m[2] === '/' ? 'selfclose' : 'open' });
    }
    tagCloseRe.lastIndex = 0;
    while ((m = tagCloseRe.exec(lineText))) {
      tokens.push({ idx: m.index, kind: 'close' });
    }
    tokens.sort((a, b) => a.idx - b.idx);

    for (const tok of tokens) {
      if (tok.kind === 'open') { depth++; started = true; }
      else if (tok.kind === 'selfclose') { started = true; }
      else if (tok.kind === 'close') { depth--; }
    }

    endIdx = i;
    if (started && depth <= 0) break;
  }

  const startLine = startIdx + 1;
  const endLine = endIdx + 1;
  const snippet = lines.slice(startIdx, endIdx + 1).join('\n');
  return { startLine, endLine, snippet };
}
