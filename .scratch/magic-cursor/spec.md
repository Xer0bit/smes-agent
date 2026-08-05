# Magic Cursor: scoped visual selection for AI edits

Status: needs-triage

## Why

Every edit today goes through the general agent loop
(`server/src/services/agentLoopService.ts`): the model gets a hybrid-retrieval
working set (direct mention + import graph + vector KB — see
`docs/agents/agent-loop.md`) and has to *locate* what to change before it can
change it. For a "make this button bigger" class of request, that's wasted
tokens and a real ambiguity risk (multiple buttons, similar JSX shapes) — the
exact failure mode `agent_edit_reliability.md` (project memory) spent 5 days
chasing. Magic Cursor removes the "locate" step: the user points at the exact
DOM node(s), we resolve that to exact `{file, line range}` before the model
ever runs, and the prompt is pre-scoped instead of hoping retrieval guesses
right.

## Current state (verified against the repo, not assumed)

This is **not greenfield** — a real single-select precursor already exists
and this spec extends it rather than replacing it:

- `preview-service/lib/client-scripts/inspector.js` — injected into the
  preview iframe. On click, walks up to 4 DOM ancestors building a CSS
  selector (`tag.class:nth-of-type`), grabs `innerText` (first 100 chars) and
  three computed style properties (`color`, `backgroundColor`, `fontSize`),
  posts `{type: 'ecg-element-selected', selector, tagName, text, rect,
  style}` to the parent via `postMessage`.
- `src/pages/Editor.tsx` — `inspectMode`/`inspectTarget` state, a
  `window.addEventListener('message', ...)` handler (search
  `ecg-element-selected`) that captures the payload, a small popover
  (~line 2657) with text/color/bg mini-editors, and `applyQuickEdit()`
  (~line 382) which turns the diffed fields into a **natural-language
  instruction** — `` `Precisely edit ${fingerprint}, matching CSS selector
  \`${selector}\`: ${changes}` `` — and sends it into the *same* general
  agent-loop prompt pipeline as a normal chat message.
- **The gap**: this mechanism never touches source. It identifies a
  *rendered DOM node*, describes it in prose, and trusts the model to
  re-locate the matching JSX in the full file context and edit it correctly.
  It's single-select, text/color/bg only, and provides zero token savings —
  if anything it *adds* a prose round-trip on top of normal retrieval.
- **Edit application already supports scoped patches** —
  `agentLoopService.ts` already has an `edit_file` tool using SEARCH/REPLACE
  diff blocks (`<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE`, see
  ~line 2895) alongside `write_file` for full rewrites, with tier
  classification steering the model toward `edit_file` for small changes.
  **Magic Cursor's job is entirely upstream of this** — get the model a
  precise `{file, line range, source}` so it reliably reaches for
  `edit_file` instead of guessing at `write_file`. We are not building a new
  diff/patch applier.
- **The other gap, and the good news**: DOM→source mapping does not need new
  build tooling. The preview is served by Vite's dev server via
  `@vitejs/plugin-react`, which in dev mode automatically runs
  `@babel/plugin-transform-react-jsx-source` — confirmed present in
  `preview-service/package-lock.json` and materialized in
  `preview-service/projects/*/​.vite-cache/deps/chunk-HZX2WZW5.js` (`__source`
  handling). Every JSX element already carries `__source: {fileName,
  lineNumber, columnNumber}` in dev mode — this is the same mechanism React
  DevTools and `click-to-react-component`-style tools use. It's reachable at
  runtime off the DOM node's React Fiber: `element[Object.keys(element)
  .find(k => k.startsWith('__reactFiber$'))]`, then walk `.return` for
  `._debugSource` / `._debugOwner`. **No new dependency required.**

## Phase 0 — Selection model

**Selection unit = one JSX element instance**, identified by
`{file, line, column}` from `__source` (not a CSS selector — CSS selectors
drift the instant a class changes; source position doesn't). This is
*component-level when the clicked node is the root return of a component*,
*element-level otherwise* — the distinction is derived, not chosen up front:

- Walk the Fiber's `.return` chain from the clicked host node. The first
  Fiber whose `type` is a function/class component (not a DOM tag string) is
  the **owning component**. Its `.elementType.name` is the component name.
- If the clicked DOM node *is* that component's sole top-level JSX return, the
  selection is **component-level** — the whole component's source range is
  the target.
- Otherwise it's **element-level** — a JSX subtree inside a larger component,
  scoped to just that node's own `[line, line + subtreeLineCount]`.
- File-level selection is out of scope for v1 — "select whole file" is
  already what happens when nothing is selected (today's default retrieval).
  Revisit only if usage data shows people fighting the granularity.

**Multi-select**: additive via ⌘/Ctrl+click (mirrors the existing single
`inspectMode` toggle — shift is reserved by most browsers for text
selection inside the iframe). Each additional click appends to
`inspectTargets: InspectTarget[]` rather than replacing. Cross-file selection
is allowed and expected (e.g. a component + the hook it calls) — the
extractor (Phase 1) groups by file, not by selection order.

**Nesting/overlap resolution**: if a newly-clicked node is a DOM descendant
of an already-selected node's subtree, do **not** add a second entry —
selecting a child inside an already-selected parent is very common (parent
picked first for "restyle this whole card", then user also clicks the price
text to also mention it) and per Phase 3's execution rule the outer
selection is authoritative. Clicking a node that is an *ancestor* of an
already-selected node **replaces** the child selection with the parent
(expanding scope is an explicit user action, so it's allowed) — but this
narrows to "add both" if the user's next words in the prompt reference the
child specifically (e.g. "...and make the price red"); that's a Phase 2
prompt-construction concern, not a selection-model one.

**Selection → context mapping** (what actually gets sent, kept minimal by
default):
- `file` (relative path), `componentName`, `[startLine, endLine]` for the
  selected range
- The exact source slice for that range (not the whole file)
- One level up: the immediate parent JSX wrapper's opening tag + props
  (context, not edit target — lets the model see e.g. it's inside a `<Card>`
  without shipping the whole `Card` source)
- Any local CSS custom properties / Tailwind theme tokens referenced in the
  slice's `className` strings that resolve to `src/index.css` tokens (grep
  `var(--x)` and known semantic Tailwind classes against the token list) —
  not the whole stylesheet, just the referenced token *values*
- Explicitly **excluded by default**: full file content outside the range,
  sibling components, unrelated hooks/state in the same file, the full
  import graph. These are added only via the Phase 1 fallback, never
  speculatively.

## Phase 1 — Scope isolation system

**Extractor** (new, `server/src/services/magicCursorContext.ts` or similar —
runs server-side since it needs the actual project file contents, which live
in Storage per `docs/storage-architecture.md`, not in the browser):

1. Input: `InspectTarget[]` — each `{file, startLine, endLine, componentName,
   selector}` (selector kept only as a fallback disambiguator, not primary
   key).
2. For each target: read the file (already-loaded workspace file, no new
   fetch), slice `[startLine - 1, endLine + 1]` (1-line pad), record actual
   byte range for later patch anchoring.
3. Resolve one level of "immediate dependency": walk up from `startLine` in
   the same file to the nearest enclosing JSX element's opening tag (for
   parent-wrapper context) and scan the slice's `className`/`style` for
   token references, resolved against `src/index.css`'s `:root` block.
4. Deeply nested **unchanged** children inside the selected range (e.g. a
   selected `<Card>` containing a 40-line untouched `<Chart>` subtree) are
   collapsed to a placeholder: `{/* unchanged: <Chart ...117 lines... /> */}`
   — the model is told this placeholder means "leave verbatim," and the real
   lines are restored after the model's response by matching the placeholder
   back to the original byte range (never regenerated).
5. Token budget: **4,000 input tokens per Magic Cursor request** as the
   ceiling (roughly 3x a typical single-component source slice — generous
   headroom, not a tight squeeze). If the sum of raw slices + parent context
   exceeds it: collapse step 4's placeholder rule more aggressively first
   (drop the pad line, collapse any child subtree over 15 lines regardless of
   whether it's "changed" — re-expand only if the model's response references
   something inside it, which triggers one extra turn to fetch that specific
   child, not the whole file). Never truncate a selected range itself — if a
   single selected component alone exceeds budget, that's Phase 4's
   "insufficient context" logging case, not silent truncation.

**Fallback (missing context) rule**: if the model's response references an
identifier not present in the scoped context (a hook, a sibling prop, a
style var it needed but wasn't included), the orchestrator does **one**
targeted follow-up: grep the project for that identifier's definition, send
back just that definition (not the whole file it lives in), and let the
model retry. Two failed fallback rounds → surface to the user as "this edit
needs more context than the selection provides — expand selection to include
X?" rather than silently falling back to full-file (this is the one place
the existing general agent loop remains the true fallback, but only on
explicit user confirmation, never automatically).

## Phase 2 — Prompt construction

New prompt template (distinct from the general chat system prompt in
`agentLoopService.ts` — Magic Cursor requests should NOT go through
intent-tier classification since scope is already known, skipping
`docs/agents/agent-loop.md` §1's retrieval entirely):

```
You are editing SPECIFIC, PRE-SELECTED code regions. Do not modify anything
outside the regions below, even if the instruction implies broader impact —
if you believe a change outside these regions is required, do not make it;
instead end your response with a PROPOSED_ADDITIONAL_CHANGE block describing
what and why, and stop.

Do not reformat, re-indent, or rewrite untouched lines within a region,
even ones adjacent to your edit.

--- REGION 1 ---
File: src/components/PricingCard.tsx
Lines: 42-58
Component: PricingCard
Parent context: <div className="grid grid-cols-3 gap-6"> (no other constraints)
Style tokens referenced: --primary (hsl(180 70% 45%)), --radius (0.625rem)
Source:
<exact 42-58 slice, byte-identical to file on disk>
--- END REGION 1 ---

[--- REGION 2 --- ... if multi-select, cross-file or same-file, always
individually delimited and individually line-ranged, never merged into one
blob even when adjacent in the same file]

User instruction: "<verbatim, untouched, not paraphrased>"

Respond with one SEARCH/REPLACE edit_file call per region that needs a
change (use the existing edit_file tool — SEARCH block must match the
region's source exactly). Do not call write_file for these regions unless
the edit necessarily changes the component's own boundaries (e.g. splitting
one component into two) — in that case say so explicitly before doing it.
```

This reuses `edit_file`'s existing SEARCH/REPLACE contract
(`agentLoopService.ts` ~2895) rather than inventing a new patch format — the
only new thing is *how the model is scoped before it acts*, and a
requirement that multi-region edits come back as N separate `edit_file`
calls (one per region) instead of one calling covering everything, so a
failure in region 2 doesn't block region 1 from landing.

## Phase 3 — Precision execution rules

- The model must not touch code outside the delimited regions. If the
  instruction implies broader impact ("make all buttons this color"), the
  agent flags it as a `PROPOSED_ADDITIONAL_CHANGE` (see template above) and
  stops — the orchestrator surfaces this as a suggestion chip
  ("Also apply to 6 other buttons? [Preview] [Apply] [Skip]"), never
  auto-executes.
- Unselected code must survive byte-for-byte — enforced by construction:
  `edit_file`'s SEARCH block must match verbatim, so any drift (the model
  "helpfully" reformatting something outside its SEARCH block) simply fails
  to apply rather than silently landing. This is inherited behavior, not new
  code — the existing `edit_file` tool already fails a non-matching SEARCH
  block per its current implementation, per `agent_edit_reliability.md`
  (project memory) Case B/C/D fixes for stuck/false-negative match
  detection.
- Nested-selection conflict resolution (parent + child both selected — see
  Phase 0): outer/parent selection is authoritative *unless* the verbatim
  instruction explicitly calls out the child ("...and make the price red")
  — in which case both regions are sent, parent's edit_file call executes
  first, child's second, and if the parent's edit already covers the line
  range the child pointed at (parent was rewritten wholesale), the child's
  SEARCH block will fail to match by construction — surfaced to the user as
  "price edit skipped, already covered by card edit," not silently dropped.
- Patch application: unchanged, reuses `edit_file`'s existing SEARCH/REPLACE
  mechanism. No new diff applier is being built for this feature.

## Phase 4 — Token efficiency validation

Benchmark methodology (to run once implemented, not estimated here):
- Pick 10 representative single-component edits and 5 multi-select edits
  from real usage (or synthesize from the existing project templates in
  `TemplateGallery.tsx`).
- For each, record input tokens under **today's path** (general agent loop,
  hybrid retrieval — `docs/agents/agent-loop.md`) vs **Magic Cursor path**
  (this spec's extractor output).
- Target: 60-80% input-token reduction for the single/multi-component case,
  per the task's own target — realistic here specifically *because* today's
  baseline includes whatever the hybrid retriever pulls in (direct mention +
  import graph + vector KB chunks), which is generally much larger than one
  component's source.
- Log every case where the Phase 1 fallback fired (missing context) with
  what was missing and how large the follow-up fetch was — this is the real
  signal for whether the "one level of immediate dependency" heuristic in
  Phase 1 is calibrated correctly, and should feed back into tightening or
  loosening it, not be treated as one-off noise.

## Phase 5 — UX integration

- **Selection state**: extend `inspector.js`'s existing `highlight()`
  overlay (already draws a hover outline) to distinguish hover (dashed,
  low-opacity) from committed selection (solid `#6366f1` border + subtle
  fill, already the color used today) — and add a small numbered badge
  (`1`, `2`, ...) per selected element for multi-select, positioned at the
  element's top-left corner via the existing `getBoundingClientRect()` data
  already being posted.
- **Prompt input surface**: reuse the existing inspect-mode popover location
  (`Editor.tsx` ~line 2657) rather than a new floating input — it already
  anchors near the AgentChatPanel's edit affordances. Replace its
  text/color/bg mini-editors with a single free-text field once ≥1 selection
  is committed (the mini-editors remain for the single-element,
  no-free-text-typed case as a fast path — this is additive, not a
  replacement of the existing quick-edit UX).
  Selection persists across typing (it already does — `inspectTarget` is
  independent state from the input).
- **Post-edit feedback**: scoped to exactly the regions that were sent —
  reuse the existing per-message step list in `AgentChatPanel.tsx`
  (`msg.steps`, see the "N changes" chip work done earlier this session)
  but filtered to only the files/line-ranges in this request's regions, not
  the general per-run file list.

## Deliverable: component/file list for implementation

| Component | New or extends | Path |
|---|---|---|
| Fiber-walk source resolver | extends | `preview-service/lib/client-scripts/inspector.js` — add `__source` extraction via Fiber walk, multi-select state, numbered-badge overlay |
| Selection engine (client) | new | `src/pages/editor/hooks/useMagicCursor.ts` — owns `inspectTargets[]`, ⌘/Ctrl+click accumulation, nesting resolution (Phase 0) |
| Context extractor (server) | new | `server/src/services/magicCursorContext.ts` — Phase 1 extraction, token budgeting, placeholder collapsing |
| Prompt composer | new | `server/src/services/magicCursorPrompt.ts` — Phase 2 template, feeds into existing `runAgentLoop()` as a distinct entry path (bypasses tiering/retrieval) |
| Execution rule enforcement | extends | `server/src/services/agentLoopService.ts` — new Magic Cursor entry branch; no changes to `edit_file` itself |
| Selection UI overlay | extends | `src/pages/editor/components/PublishDialog.tsx`-style new component: `src/pages/editor/components/MagicCursorPanel.tsx`, replacing the inline popover currently at `Editor.tsx` ~2657 |
| Benchmark harness | new | `.scratch/magic-cursor/benchmarks/` (script + logged results, not shipped code) |

## Test matrix

| Case | What it verifies |
|---|---|
| Single select, element-level (a `<span>` inside a larger component) | Correct Fiber walk stops at element, not component; correct line-range slice |
| Single select, component-level (click on a component's root return) | Fiber walk correctly identifies "this IS the component root," sends full component range |
| Multi-select, same file | Two regions correctly delimited and independently `edit_file`'d; one failing SEARCH doesn't block the other |
| Multi-select, cross-file | Extractor groups by file correctly; prompt template emits per-file regions; two separate `edit_file` calls target different files in one response |
| Nested selection (parent then child clicked) | Parent stays authoritative by default; verbatim instruction mentioning the child promotes it to a second region; child's SEARCH failing post-parent-rewrite surfaces as "already covered," not a silent no-op |
| Oversized selection requiring summarization | A selection whose raw slice + parent context exceeds 4,000 tokens correctly triggers placeholder collapsing (Phase 1 step 5), and never silently truncates the actually-selected range itself |
| Missing-context fallback | A selected region whose edit needs an out-of-scope hook/style var triggers exactly one targeted follow-up fetch, not a full-file fallback; two failed rounds surface the user-facing "expand selection?" prompt |
| `PROPOSED_ADDITIONAL_CHANGE` path | An instruction implying broader impact than the selection produces a flagged suggestion, not an unprompted edit outside the regions |

## Open questions (not resolved by this spec)

- Whether ⌘/Ctrl+click is discoverable enough without onboarding, or needs a
  first-use tooltip — a UX call, not an architecture one.
- Whether the "4,000 token ceiling" should be tier-aware (matching the
  existing micro/fix/edit/feature/build tiers in `docs/agents/agent-loop.md`
  §1) rather than one fixed number — deferred until Phase 4 benchmark data
  exists to justify it.
