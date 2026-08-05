Status: needs-triage
Blocked by: 01

# Server-side scope isolation extractor

## What

New `server/src/services/magicCursorContext.ts`. Given `InspectTarget[]`
(the enriched `source` payloads from ticket 01), produce the minimal
sufficient context per spec Phase 1: source slice per region, one level of
parent-wrapper context, referenced style tokens resolved against
`src/index.css`, deeply-nested unchanged children collapsed to placeholders,
all under a 4,000 input-token ceiling.

## Approach

1. Input shape: `Array<{file: string, startLine: number, endLine: number,
   componentName: string, isComponentRoot: boolean}>`.
2. Read each file from the already-loaded project workspace (same file
   source the agent loop already reads from — no new Storage fetch path,
   reuse whatever `agentLoopService.ts` uses today to read project files).
3. For element-level targets (not `isComponentRoot`), determine the JSX
   subtree's actual end line by matching balanced JSX tags forward from
   `startLine` (simple tag-depth counter, not a full parser — this repo's
   files are consistently formatted so this is reliable enough; fall back to
   the client-reported `endLine` if depth-matching fails).
4. Parent-wrapper context: scan backward from `startLine` for the nearest
   enclosing opening JSX tag at a shallower indent/depth; capture just that
   opening tag line (not its own children).
5. Style token resolution: regex-scan the slice's `className` strings for
   Tailwind semantic classes (`bg-primary`, `text-muted-foreground`, etc.)
   and `var(--x)` references; look up each against the `:root` block parsed
   from `src/index.css`; include resolved values inline as a small table,
   not the whole stylesheet.
6. Placeholder collapsing: walk the slice's own JSX children; any child
   subtree deeper than the immediate selection with more than ~15 lines gets
   replaced with `{/* unchanged: <ComponentName ...N lines... /> */}` and
   its real byte range recorded in a side-table keyed by placeholder id, so
   it can be spliced back into the model's response verbatim regardless of
   what the model does with the placeholder text itself.
7. Token budgeting: sum estimated tokens (chars/4 heuristic is fine, this
   doesn't need to be exact) across all regions; if over 4,000, re-run step 6
   with a lower collapse threshold (drop to 5-line threshold) before ever
   trimming a *selected* range.
8. Output: `{regions: MagicCursorRegion[], estimatedTokens: number,
   placeholders: Map<string, {file, startByte, endByte, originalText}>}`.

## Acceptance

- A single small component selection produces context under ~500 tokens.
- A selection containing a genuinely large unchanged child subtree (test
  fixture: a card component wrapping a 100+ line chart) gets that subtree
  collapsed and the token count verified to drop accordingly.
- Placeholder round-trip: feed a fabricated model response containing an
  unmodified placeholder token back through a "restore" step and confirm the
  original bytes come back exactly.
