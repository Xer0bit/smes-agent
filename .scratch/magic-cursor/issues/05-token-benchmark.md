Status: needs-triage
Blocked by: 03

# Token efficiency benchmark

## What

`.scratch/magic-cursor/benchmarks/` — a script (not shipped product code)
that runs the 15-case set from spec.md Phase 4 through both the existing
general agent-loop path and the new Magic Cursor path, logging input token
counts for each, plus every fallback-triggered case with what was missing.

## Approach

1. 10 single-component + 5 multi-select cases, sourced from real project
   templates in `TemplateGallery.tsx` where possible so the numbers reflect
   actual generated-app code shapes, not synthetic toy components.
2. For each case, capture: today's hybrid-retrieval input token count
   (`docs/agents/agent-loop.md` §1 path) vs Magic Cursor's extractor output
   token count (ticket 02).
3. Report: per-case reduction %, aggregate median/mean reduction, and a
   distinct log of every case where the Phase 1 fallback fired (ticket 02
   step on missing context) — what identifier was missing, how large the
   follow-up fetch was.
4. This ticket's output feeds the open question in spec.md ("should the
   token ceiling be tier-aware") — do not resolve that question here, just
   produce the data.

## Acceptance

- A results table/file showing per-case and aggregate reduction numbers.
- Aggregate reduction in the 60-80% range for the single/multi-component
  cases, per spec target — if it's not, that's a real finding to report
  back against spec.md's Phase 1 heuristics (parent-context inclusion,
  collapse threshold), not something to force by shrinking the benchmark
  set until it passes.
