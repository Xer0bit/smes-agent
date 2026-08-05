Status: needs-triage

# Fiber-walk source resolver + multi-select in inspector.js

## What

Extend `preview-service/lib/client-scripts/inspector.js`'s click handler to
resolve the clicked DOM node to `{file, line, column, componentName}` via the
React Fiber tree instead of (or in addition to, as a fallback) the current
CSS-selector-only approach.

## Why

Vite's React plugin already injects `__source: {fileName, lineNumber,
columnNumber}` into every JSX element in dev mode (confirmed present via
`@babel/plugin-transform-react-jsx-source` in
`preview-service/package-lock.json`) — this ticket wires up reading it, no
new dependency.

## Approach

1. On click, find the Fiber key on the DOM node:
   `Object.keys(el).find(k => k.startsWith('__reactFiber$'))`.
2. Read `fiber.return` chain. For each ancestor Fiber, check
   `typeof fiber.type === 'function'` (or has a `.render` for class
   components) to find the owning component Fiber; read `.elementType.name`
   for the component name.
3. Read `_debugSource` off the *host* Fiber (the DOM element's own fiber, not
   the component's) for `{fileName, lineNumber, columnNumber}` — this is the
   JSX call site.
4. Determine component-level vs element-level (spec Phase 0): compare the
   clicked host Fiber's line against the owning component Fiber's own
   `_debugSource` line — if they're the same JSX return statement, it's
   component-level.
5. Post the enriched payload: extend the existing
   `{type: 'ecg-element-selected', ...}` message with `source: {file, line,
   column, componentName, isComponentRoot}`. Keep the existing
   `selector`/`rect`/`style` fields for backward compat with the current
   single-select quick-edit UI (ticket 03 replaces its consumer, this ticket
   only adds the new field).
6. Add ⌘/Ctrl+click detection (`e.metaKey || e.ctrlKey`) to append to a
   `_selectedElements` array instead of replacing; post a new message type
   `ecg-multi-select-changed` with the full array whenever it changes.
7. Nesting resolution (spec Phase 0): before appending, check if the new
   target's DOM node is a descendant of any already-selected node
   (`existingNode.contains(newNode)`) — skip if so. Check the reverse
   (`newNode.contains(existingNode)`) — if so, replace that entry instead of
   appending.
8. Numbered badge overlay: extend `highlight()` to draw a small numbered
   label per committed selection (not just the hover ghost), positioned via
   the same `getBoundingClientRect()` already computed.

## Out of scope

- Nothing server-side. This ticket is 100% the injected client script.
- No changes to how `Editor.tsx` consumes the message yet (ticket 02/03).

## Acceptance

- Clicking a DOM node inside a component's JSX correctly reports the real
  source file/line, verified by comparing against the actual file on disk
  for at least 3 different component shapes (a leaf element, a component
  root, a deeply-nested conditional render).
- ⌘/Ctrl+click accumulates without duplicating already-covered nodes.
