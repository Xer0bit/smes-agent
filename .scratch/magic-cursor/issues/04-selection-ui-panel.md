Status: needs-triage
Blocked by: 01

# Magic Cursor selection panel (client UI)

## What

`src/pages/editor/hooks/useMagicCursor.ts` (selection engine — owns
`inspectTargets[]` client-side state, consumes the `ecg-multi-select-changed`
postMessage from ticket 01) and
`src/pages/editor/components/MagicCursorPanel.tsx` (replaces the inline
popover currently at `Editor.tsx` ~line 2657), following the same
props-driven-component pattern already used for `PublishDialog`-style
extraction from this session's `src/pages/editor/` split.

## Approach

1. `useMagicCursor.ts`: mirrors `inspectMode`/`inspectTarget` state currently
   inline in `Editor.tsx`, but as `inspectTargets: InspectTarget[]` (array).
   Listens for `ecg-multi-select-changed`. Exposes `clearSelection()`,
   `removeTarget(index)`.
2. `MagicCursorPanel.tsx`: single free-text input once ≥1 target is
   selected, with a compact list of selected targets (component name +
   file:line, per spec Phase 5) each with a remove (×) affordance. Keep the
   existing single-element text/color/bg mini-editors as the fast path when
   exactly one *element-level* (not component-level) target with visible
   text is selected — this is additive to the current UX in
   `Editor.tsx`, not a replacement; do not regress the existing quick-edit
   flow for that specific case.
3. Submitting: calls into ticket 03's entry path instead of
   `handleGenerateWithContext`'s general path, passing `inspectTargets` +
   the free-text instruction.
4. Post-edit feedback (spec Phase 5): filter `AgentChatPanel`'s existing
   per-message step list (`msg.steps`) to only the files/ranges in the
   submitted regions before rendering the "N changes" chip for this message.

## Acceptance

- Single-select text/color/bg fast path behaves identically to today's
  `applyQuickEdit()` (no regression — this is the one place byte-for-byte UX
  parity matters, since real users already rely on it).
- Multi-select shows a numbered list matching the numbered badges from
  ticket 01's overlay.
- Removing one target from the list updates the preview overlay
  (round-trips back through a message to the iframe).
