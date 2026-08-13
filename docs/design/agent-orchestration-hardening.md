# Agent orchestration hardening

## Problem

`agentLoopService.ts` (~4700 lines) is the single flat tool-calling loop behind
every EcomGear agent request. It has accreted many real, incident-driven
fixes over months — each with a dated comment naming the production incident
it closed. Two live incidents from today's session expose the current shape
of the problem directly:

1. **Uneven robustness across tool categories.** File-mutation tools
   (`write_file`/`edit_file`/`delete_file`/`rename_file`) got a hard-block
   circuit breaker on 2026-08-11/12 after a real thrash incident. Live PM2
   logs pulled today (project `dfe41091`, 07:49–07:56) showed
   `write_edge_function` failing 10+ consecutive steps across two separate
   runs, burning real cost with zero landed change — the exact same failure
   class, just never extended past file tools. Fixed today
   (`agentLoopService.ts`, `agentToolSet.ts`). Database-action tools
   (`query_database`, `provision_database`, `confirm_database_change`) have
   the *same* structural gap, unconfirmed by a live incident yet but
   identical in shape.
2. **No reusable delegation primitive despite two working precedents.**
   The post-run auto-repair pass (`agentLoopService.ts:3750-4024`) and the
   fix-tier diagnosis-seeding pass (`:1664-1754`) both independently built
   the same shape: an isolated `messages` array, a filtered read-only or
   narrow toolset, its own step/token budget, a result fed back into the
   main run. Neither reuses the other's code. A third category of work this
   session — a live-log root-cause pull — had to be done as raw SSH/grep
   because there is no in-loop primitive that could have run "diagnose why
   write_edge_function is failing" as a bounded sub-call.

Beyond these two, the broader ask is to close the remaining gaps between
this harness and a general-purpose orchestration-capable agent loop:
persistent cross-session memory, a real (not just available) test-execution
verification signal, and cost efficiency — without regressing the extensive,
hard-won reliability work already in this file (circuit breakers, prompt
caching, compaction, scope gating, honest-failure messaging).

**What "junk code" grounding found:** see `## Open questions` — a dedicated
grounding pass is in flight; this section will be finalized with concrete
file:line findings before the spec is drafted, not guessed at.

## Goals / Non-goals

- **Goals:**
  - Extend the proven hard-block circuit-breaker pattern to every
    mutation-capable tool category (database actions; edge functions already
    done today), not just file tools.
  - Extract a single reusable bounded-sub-call primitive from the two
    existing precedents, refactor both onto it with zero behavior change,
    and prove it with one new real call site.
  - Extend fix-tier's auto-scope-seeding pattern to edit/feature/build tiers
    (currently 0% coverage on tiers that carry the majority of traffic).
  - Give test execution a structured pass/fail signal (mirroring
    `lastBuildErrorsHealthy`) instead of raw unparsed text, and invoke it
    automatically where `get_build_errors` already is.
  - Add persistent, project-scoped, cross-session agent memory — currently
    `brainMemory[]` is discarded at run end and no equivalent table exists.
  - Remove genuinely dead/duplicate code and stale comments identified by
    grounding (evidence-based only, not a style pass).
  - Close the sub-`COMPACT_AFTER_STEP` short-run cost gap: a run of ≤6 steps
    never reaches the compaction threshold, so per-step cost only grows for
    the entire run. (Cross-run prompt-cache reuse was also suspected as a
    gap but is confirmed already working — live log evidence shows
    `cacheR=30400` on step 1 of a brand-new run on a previously-touched
    project, i.e. the static system-prompt cache breakpoint is already being
    hit across separate requests, not just within one run. No fix needed
    there.)
- **Non-goals:**
  - Changing the $1.50 hard cost cap (business/pricing policy).
  - Broadening beyond React/Vite tenant-app generation into a
    general-purpose multi-language coding agent (product-scope decision).
  - A full multi-agent swarm rewrite of the main loop.
  - Generalizing diagnosis/scope-seeding beyond what a direct extension of
    the existing fix-tier pattern covers.
  - Style-only refactors with no evidence of dead/duplicate/unreachable code.

## Approaches

### A. Circuit-breaker coverage for database-action tools

| # | Approach | Pros | Cons |
|---|----------|------|------|
| A1 | Extend `MUTATION_TOOLS`/`MUTATION_KEY_FIELD` (today's edge-function pattern) keyed by a query fingerprint (`computeErrorFingerprint`-style hash of the SQL text) instead of a stable name/path | Reuses the exact mechanism proven twice already; minimal new code | `query_database` is dual-purpose (reads + writes) — need to confirm hashing the raw query text doesn't over-trigger on legitimately-varying exploratory `SELECT`s |
| A2 | New, separate breaker just for DB tools | Avoids conflating query semantics with file/function mutation semantics | Third near-duplicate mechanism — the thing Goal 2 (single primitive) is trying to eliminate |

### B. Bounded sub-call primitive

| # | Approach | Pros | Cons |
|---|----------|------|------|
| B1 | Extract `runBoundedSubCall(ctx, {toolNames, systemPrompt, budget})` from the auto-repair pass + diagnosis-seeding pass; refactor both onto it (behavior-preserving); one new call site (e.g. DB-action diagnosis, or the test-verification pass from Goal 4) | Both existing precedents already converged on this exact shape independently — strong evidence it's the right cut; refactor-with-existing-coverage de-risks it | Refactoring two already-battle-tested paths carries real regression risk; needs careful behavior-preservation discipline |
| B2 | Leave the two precedents as-is, build a third bespoke bounded call for each new need | Zero risk to existing paths | Compounds the exact duplication problem already observed; each future need reinvents the shape again |

### C. Persistent cross-session memory

| # | Approach | Pros | Cons |
|---|----------|------|------|
| C1 | New `project_agent_memory` table (project-scoped, capped N most-recent entries), `save_memory` tool persists in addition to the in-run array, loaded at `_runAgentLoopInner` start and injected alongside the working-set context | Small, additive, mirrors the existing `agent_plans` precedent (separate table, write-then-later-read) | Needs an eviction/cap policy to avoid unbounded prompt growth over a long-lived project |
| C2 | Extend `project_settings` (existing key-value jsonb store) with an `agent_memory` key | No new table/migration | `project_settings` is documented as config-scoped; conflates two different concerns in one store |

## Recommendation

A1, B1, C1 — each reuses an already-proven pattern in this exact codebase
rather than inventing new architecture, which matches the evidence: every
robustness mechanism that actually worked here (mutation circuit breaker,
diagnosis-seeding, `agent_plans`) was a *narrow extension of an existing
precedent*, and every incident found today traces to a precedent that
existed but wasn't extended far enough, not to a missing architecture.

## Open questions

- Junk-code grounding pass (dead exports, unreachable branches, duplicate
  mechanisms, stale comments, dead env flags) is in flight — findings will
  be folded into a `## Checkpoint: cleanup` scope in the spec once returned,
  not before.
- A2 vs A1 hinges on how often `query_database` is called with genuinely
  novel exploratory SQL vs. repeated identical mutating statements — no live
  incident evidence yet, unlike edge functions.
