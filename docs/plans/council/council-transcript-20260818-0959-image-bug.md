# LLM Council Transcript — Image Crash Architecture (round 2)
2026-08-18 09:59. Question: what is the actual architectural root cause of
the recurring "images disappear/corrupt on editor reload" bug, and is the
engineering response to it (5 confirmed root causes patched one at a time)
sound?

Anonymization mapping: A=Contrarian, B=FirstPrinciples, C=Expansionist,
D=Outsider, E=Executor.

## Advisor responses (full text)
See prior tool messages in this session for the five full advisor responses.
Condensed: all five independently converged on the same diagnosis before
peer review even began — five "root causes" are one missing invariant
(no source of truth, the browser sits untrusted in the write path, prune
deletes on absence with no integrity check).

## Peer reviews (5) — condensed
- All 5 reviewers: strongest = A (Contrarian) — only response grounded in
  actual code (`pruneProjectFiles`, the exemption list, the second
  unsentineled writer in `microvmRunner`), and the only one to separate the
  reported symptom (deletion) from what fix 3 addressed (corruption).
- Blind spot called out repeatedly: B and C's rearchitecture proposals have
  zero interim mitigation for a solo founder with customers bleeding today.
- Convergent misses across reviewers:
  1. **Existing damage does not self-heal.** Every fix is forward-only;
     already-corrupted revision rows and already-pruned preview files
     persist. Reviewer 5's sharpest catch: fix 3's new preview-service guard
     (refuse to overwrite a binary file lacking the sentinel) **permanently
     pins an already-corrupt file on disk** — it converts transient
     corruption into unfixable corruption, since no future good push can
     overwrite it either.
  2. **Nobody diagnosed the live instance before theorizing more.** Pull the
     actual affected project's revision rows and preview disk NOW; one diff
     tells you which of A-E (or a new cause) is actually firing this time.
  3. **Bundle/timing verification gap.** Fix 5 is client-only; confirm the
     browser reporting "still broken" was actually running the deployed
     bundle, and pin the report to a timestamp relative to deploy time —
     otherwise it may be pre-existing damage becoming visible, not new
     evidence of a sixth cause.
  4. **Fix 5's own risk**: `clearWorkspaceManager` on unmount is gated on
     `isDirty` being correct. If that flag is ever wrong, the fix silently
     discards unsaved user edits — a worse bug than the one it patches, and
     the one fix nobody verified.

## Chairman synthesis
See council-report-20260818-0959-image-bug.html for the full verdict.
