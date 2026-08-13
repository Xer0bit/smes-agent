# Agent orchestration hardening

## Goal

Harden `agentLoopService.ts`'s tool-calling loop against the two live-incident-shaped
gaps found this session (an unguarded database-mutation tool category, no reusable
bounded-sub-call primitive despite two independent precedents) and close the
remaining gaps toward a general-purpose orchestration-capable loop (scope-seeding
coverage on the majority-traffic tiers, a real test-verification signal, persistent
cross-session memory), all without regressing the existing, incident-driven
reliability mechanisms already in this file.

## Non-goals

- Changing the $1.50 hard cost cap.
- Broadening beyond React/Vite tenant-app generation into a general-purpose
  multi-language coding agent.
- A full multi-agent swarm rewrite of the main loop.
- Generalizing diagnosis/scope-seeding beyond checkpoint 3's direct extension of
  the existing fix-tier pattern to edit/feature/build tiers.
- Style-only refactors with no evidence of dead/duplicate/unreachable code
  (checkpoint 6 removes only what a fresh investigator dispatch confirms).

## Success criteria

- [ ] `query_database`, `confirm_database_change`, and `provision_database` are
      hard-blocked after an identical-failure retry streak, mirroring the existing
      file/edge-function mutation breaker.
- [ ] A single `runBoundedSubCall` primitive backs the diagnosis-seeding pass, the
      auto-repair pass, and one new call site, with zero behavior change to the two
      existing passes.
- [ ] Auto-scope-seeding runs before the first write-family tool call on edit,
      feature, and build tiers, not just fix.
- [ ] `ctx.lastTestRunHealthy` is a structured pass/fail signal set from real
      test-execution output and is consulted wherever `ctx.lastBuildErrorsHealthy`
      already gates closure claims.
- [ ] A project-scoped `save_memory` entry persists past the run that created it and
      is loaded into context at the start of the next run on the same project.
- [ ] Any code removed under checkpoint 6 is removed only because a fresh
      investigator dispatch confirmed it dead, duplicate, or stale.
- [ ] `compactStepMessages` applies a tier-scaled, lower compaction threshold
      for step budgets too small for the existing `COMPACT_AFTER_STEP`/
      `KEEP_RECENT_STEPS` pair to ever engage (today, `micro`'s 8-step
      budget), with zero change to compacted output for tiers whose budget
      already crosses the threshold.

## Approach

A1 (query-fingerprint circuit breaker), B1 (extract+refactor onto one bounded-sub-call
primitive), C1 (new `project_agent_memory` table) — see
`docs/design/agent-orchestration-hardening.md`.

## Change tree

```
supabase/migrations/
└── <timestamp>_project_agent_memory.sql ....... A  (project_agent_memory table + RLS)

apps/api-gateway/src/
├── agent-tools/
│   ├── types.ts ................................ M  (AgentContext: + lastTestRunHealthy,
│   │                                                   + deriveDbMutationKey export)
│   ├── run_command.ts .......................... M  (verify-command branch sets
│   │                                                   ctx.lastTestRunHealthy)
│   └── __tests__/
│       └── run_command.test.ts ................. A  (PASSED/FAILED/no-tests-found cases)
│
└── services/
    ├── agentContextCompaction.ts ............... M  (compactStepMessages: new maxSteps
    │                                                   param scales COMPACT_AFTER_STEP/
    │                                                   KEEP_RECENT_STEPS down for step
    │                                                   budgets too small to reach them)
    ├── agentLoopService.ts ..................... M  (MUTATION_TOOLS/MUTATION_KEY_FIELD
    │                                                   extension; runBoundedSubCall
    │                                                   extraction + 2 call-site refactors +
    │                                                   1 new call site; diagnose-before-fix
    │                                                   tier condition broadened; closure-verify
    │                                                   gate consults lastTestRunHealthy;
    │                                                   project memory loaded at run start;
    │                                                   compactStepMessages call passes
    │                                                   MAX_STEPS)
    ├── agentToolSet.ts ......................... M  (MUTATION_KEY_FIELD extension +
    │                                                   dispatch-gate DB key derivation;
    │                                                   save_memory persists via
    │                                                   projectMemoryService)
    ├── projectMemoryService.ts ................. A  (save/load project-scoped agent
    │                                                   memory, capped + pruned)
    └── __tests__/
        ├── agentToolSet.dbMutationBreaker.test.ts .. A  (checkpoint 1)
        ├── agentLoopService.scopeSeeding.test.ts ... M  (checkpoint 3 cases; checkpoint 2
        │                                                  regression baseline)
        ├── agentLoopService.autoRepair.test.ts ..... A  (checkpoint 2: first coverage for
        │                                                  the previously-untested repair pass)
        ├── projectMemoryService.test.ts ............ A  (checkpoint 5)
        └── agentContextCompaction.test.ts .......... A  (checkpoint 7)
```

## Outline

`supabase/migrations/<timestamp>_project_agent_memory.sql`
  `project_agent_memory` table — project-scoped persisted memory rows, capped per project

`apps/api-gateway/src/agent-tools/types.ts`
  `AgentContext.lastTestRunHealthy` — structured test-execution pass/fail signal, mirrors `lastBuildErrorsHealthy`
  `deriveDbMutationKey` — resolves a stable per-retry key for `query_database` / `confirm_database_change` / `provision_database`

`apps/api-gateway/src/agent-tools/run_command.ts`
  verify-command branch — sets `ctx.lastTestRunHealthy` from the PASSED/FAILED/no-tests-found result

`apps/api-gateway/src/agent-tools/__tests__/run_command.test.ts`
  verify-command sets `lastTestRunHealthy` — PASSED / FAILED / no-tests-found cases

`apps/api-gateway/src/services/agentContextCompaction.ts`
  `compactStepMessages` — new `maxSteps` param scales `COMPACT_AFTER_STEP`/`KEEP_RECENT_STEPS` down for tiers whose step budget is too small to ever reach the existing pair

`apps/api-gateway/src/services/agentLoopService.ts`
  `MUTATION_TOOLS` / `MUTATION_KEY_FIELD` — extended with the 3 database-action tools
  `runBoundedSubCall` — isolated-context, filtered-toolset, budgeted `generateText` sub-call
    diagnosis-seeding pass — refactored onto the primitive, behavior-preserving
    auto-repair pass — refactored onto the primitive, behavior-preserving
    test-verification call site — new consumer, proves the primitive
  diagnose-before-fix gate — tier condition broadened from fix-only to fix/edit/feature/build
  closure-verify gate — also consults `ctx.lastTestRunHealthy` where the project has tests
  project-memory load — `projectMemoryService.loadProjectMemory` result injected into run-start context
  `compactStepMessages` call site — passes `MAX_STEPS` through as the new tier-budget argument

`apps/api-gateway/src/services/agentToolSet.ts`
  `MUTATION_KEY_FIELD` — extended; dispatch gate calls `deriveDbMutationKey` for the 3 new tools
  `save_memory` tool — also persists via `projectMemoryService.saveProjectMemory`

`apps/api-gateway/src/services/projectMemoryService.ts`
  `saveProjectMemory` — persist one entry, prune to the per-project cap
  `loadProjectMemory` — most-recent N entries for a project

`apps/api-gateway/src/services/__tests__/agentToolSet.dbMutationBreaker.test.ts`
  identical-failure DB tool call blocked at threshold — mirrors `agentToolSet.scopeGate.test.ts`'s assertion shape

`apps/api-gateway/src/services/__tests__/agentLoopService.scopeSeeding.test.ts`
  edit/feature/build tiers seed `declaredScope` before first write — mirrors the existing fix-tier case
  build-tier net-new file outside the seed is soft-tolerated, not hard-blocked

`apps/api-gateway/src/services/__tests__/agentLoopService.autoRepair.test.ts`
  auto-repair pass output unchanged after the `runBoundedSubCall` extraction

`apps/api-gateway/src/services/__tests__/projectMemoryService.test.ts`
  save then load round-trips an entry; cap prunes the oldest entry beyond N

`apps/api-gateway/src/services/__tests__/agentContextCompaction.test.ts`
  an 8-step-budget (`micro`-tier-shaped) run reaches result compaction before the run ends — checkpoint 7
  a 25+-step-budget run's compacted output is byte-identical to current behavior at every step

## Flows

Flow: DB-action mutation circuit breaker
1. agent calls `query_database` (or `confirm_database_change` / `provision_database`) and the call fails
2. `agentLoopService.ts`'s post-step accounting derives a retry key via `deriveDbMutationKey` and records/increments the failure streak in `ctx.mutationFailureStreak`, same as the existing file/edge-function path
3. on the Nth identical-failure retry, `agentToolSet.ts`'s dispatch gate hard-blocks the next call to that same (tool, key) pair with the existing BLOCKED message
4. agent switches approach (different tool, different key, or a plain-language stuck admission) to clear the block

Flow: bounded sub-call primitive reuse
1. a caller (diagnosis-seeding, auto-repair, or the new test-verification pass) invokes `runBoundedSubCall` with a toolset filter, a system prompt, and a step/token budget
2. `runBoundedSubCall` builds an isolated `AgentContext` and toolset, runs one `generateText` call against it, and returns the result
3. the caller extracts what it needs (implicated files, repaired content, PASSED/FAILED) and applies it to the main run's `ctx`

Flow: scope-seeding on edit/feature/build tiers
1. an edit, feature, or build-tier run starts
2. the diagnose-before-fix pass (now gated on tier ∈ {fix, edit, feature, build} instead of fix only) runs its bounded read-only investigation
3. implicated files seed `ctx.declaredScope` before the main loop's first write-family tool call, identically to the existing fix-tier behavior

Flow: structured test-verification signal
1. agent (or the auto-invoked test-verification bounded sub-call) runs a verify command (`npm test` / `npx vitest run`) via `run_command`
2. `run_command` sets `ctx.lastTestRunHealthy` to true/false from the PASSED/FAILED result, or leaves it unchanged on "no tests found"
3. a successful write invalidates `ctx.lastTestRunHealthy` back to undefined, same as `ctx.lastBuildErrorsHealthy`
4. the closure-verify gate consults `ctx.lastTestRunHealthy` alongside `ctx.lastBuildErrorsHealthy` before letting an unverified resolution claim reach the user

Flow: persistent cross-session project memory
1. agent calls `save_memory` during a run
2. the tool pushes to the in-run `brainMemory[]` array (existing behavior) and persists the entry via `projectMemoryService.saveProjectMemory` (new)
3. a later run on the same project calls `projectMemoryService.loadProjectMemory` at `_runAgentLoopInner` start and injects the result into the run-start context, alongside the existing file-preview context

Flow: evidence-gated cleanup
1. a fresh `atomic-investigator` dead-code sweep runs against `agentLoopService.ts` / `agentToolSet.ts` at implementation time
2. only findings the investigator confirms as dead, duplicate, or stale are removed
3. the existing test suite stays green after each removal

Flow: tier-scaled compaction for short step budgets
1. `agentLoopService.ts`'s `prepareStep` calls `compactStepMessages`, now passing `MAX_STEPS` alongside the existing `messages`/`stepNumber`/`brainMemory` arguments
2. for a tier whose `MAX_STEPS` already clears the existing `COMPACT_AFTER_STEP`/`KEEP_RECENT_STEPS` pair (fix/edit/feature/build), `compactStepMessages` uses those constants unchanged
3. for a tier whose `MAX_STEPS` is too small for that pair to ever engage (today, `micro`), `compactStepMessages` uses a scaled-down threshold instead, so older-step tool-result trimming can still happen before the run ends
4. per-step token growth flattens for the remainder of a short-budget run instead of climbing for its entire length

## Checkpoints

| # | Checkpoint | Files/areas | Agent | Est. files | Verifies |
|---|------------|-------------|-------|------------|----------|
| 1 | Extend the mutation circuit breaker to `query_database`/`confirm_database_change`/`provision_database`, keyed by a query fingerprint (`confirm_database_change` resolves its key by looking up the staged SQL from `ctx.pendingDbChanges`, not its own ephemeral `confirmationId`) | `agent-tools/types.ts`, `services/agentLoopService.ts` (~479-487, ~2012-2044), `services/agentToolSet.ts` (~360-387), new `services/__tests__/agentToolSet.dbMutationBreaker.test.ts` | atomic-implementer (mode: feature) | ~4 | New test: a 3rd identical-failure call to each of the 3 DB tools is hard-blocked with the existing BLOCKED message; a differing SQL statement is not blocked; existing file/edge-function breaker behavior is unchanged |
| 2 | Extract `runBoundedSubCall` from the diagnosis-seeding pass (`agentLoopService.ts:1697-1767`) and the auto-repair pass (`agentLoopService.ts:3894-3968`); refactor both onto it behavior-preserving; add one new call site (bounded test-execution sub-call, consumed by checkpoint 4) | `services/agentLoopService.ts`, new `services/__tests__/agentLoopService.autoRepair.test.ts` | atomic-implementer (mode: surgical) | 1-2 | `agentLoopService.scopeSeeding.test.ts` (existing diagnosis-pass coverage) stays green unmodified; new `agentLoopService.autoRepair.test.ts` (first coverage for that pass) passes pre- and post-refactor with identical assertions |
| 3 | Broaden the diagnose-before-fix gate's tier condition from `_tier === 'fix'` to fix/edit/feature/build, reusing `runBoundedSubCall` from checkpoint 2 | `services/agentLoopService.ts` (~1698 tier condition), `services/__tests__/agentLoopService.scopeSeeding.test.ts` | atomic-implementer (mode: surgical) | 1-2 | Extended `scopeSeeding.test.ts`: each of edit/feature/build seeds `ctx.declaredScope` before the first write-family call, mirroring the existing fix-tier assertion; a build-tier case writing a net-new file outside the seed is soft-tolerated (not hard-blocked on first touch) |
| 4 | Add `ctx.lastTestRunHealthy`, set it from `run_command`'s existing PASSED/FAILED verify-command output, invalidate it on successful write (mirroring `lastBuildErrorsHealthy`), and wire checkpoint 2's test-execution call site into the closure-verify gate | `agent-tools/types.ts`, `agent-tools/run_command.ts` (~275-294), `services/agentLoopService.ts` (~2116-2122 invalidation, ~2748-2790 closure-verify gate), new `agent-tools/__tests__/run_command.test.ts` | atomic-implementer (mode: feature) | ~4 | New test: `npx vitest run` PASSED output sets `lastTestRunHealthy = true`, FAILED sets `false`, "No test files found" leaves it unchanged; closure-verify gate treats an unhealthy/unset test signal the same way it already treats an unhealthy/unset build signal |
| 5 | New `project_agent_memory` table (capped, most-recent-N per project, pruned on write like `agentSnapshot.ts`'s `MAX_SNAPSHOTS_PER_PROJECT` pattern); `save_memory` persists in addition to the in-run `brainMemory[]`; loaded at `_runAgentLoopInner` start and injected alongside the existing file-preview context | new migration, new `services/projectMemoryService.ts`, `services/agentToolSet.ts` (`save_memory`, ~734-759), `services/agentLoopService.ts` (run-start context injection, ~1412-1432), new `services/__tests__/projectMemoryService.test.ts` | atomic-implementer (mode: feature) | ~5 | New test: `saveProjectMemory` then `loadProjectMemory` round-trips an entry; inserting past the cap prunes the oldest row first; a second run on the same project sees the prior run's saved memory in its run-start context |
| 6 | Dispatch a fresh `atomic-investigator` dead-code sweep of `agentLoopService.ts`/`agentToolSet.ts` at implementation time; remove only what it confirms is dead, duplicate, or stale — no findings are assumed or invented by this spec | TBD, scoped by the investigator's findings at implementation time | atomic-investigator dispatch, then atomic-implementer (mode: surgical) on confirmed findings only | TBD (expect 1-3) | Full existing test suite stays green after each removal; each removal traces to a specific investigator finding, not an inference from this spec |
| 7 | Add a `maxSteps` param to `compactStepMessages` that scales `COMPACT_AFTER_STEP`/`KEEP_RECENT_STEPS` down for tiers whose step budget is too small for the existing pair to ever engage (today, only `micro`'s 8-step budget qualifies); wire `agentLoopService.ts`'s `prepareStep` call site to pass `MAX_STEPS` through; every tier whose budget already clears the existing pair keeps today's constants unchanged | `services/agentContextCompaction.ts`, `services/agentLoopService.ts` (~1880 `compactStepMessages` call), new `services/__tests__/agentContextCompaction.test.ts` | atomic-implementer (mode: surgical) | 1-2 | New test: an 8-step-budget (`micro`-shaped) run reaches nonzero older-step tool-result compaction before its last step, where today it never does; a 25+-step-budget run's `compactStepMessages` output is byte-identical, step for step, to current behavior |

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Checkpoint 2 refactors two already-battle-tested, incident-hardened code paths onto a shared primitive; a subtle behavior change in either regresses production reliability work with real incident history | Medium | The diagnosis-seeding pass already has end-to-end coverage (`agentLoopService.scopeSeeding.test.ts`) to run before/after as a regression baseline; the auto-repair pass currently has **no** test coverage at all (grounded during spec drafting, contradicts the design doc's assumption that both precedents are covered) — checkpoint 2 must add `agentLoopService.autoRepair.test.ts` first, not rely on non-existent coverage. The two passes also diverge in token/cost accounting today (diagnosis feeds `usage` into `runTokens`/`runCostUsd`; auto-repair does not) — the primitive must expose this as an explicit option, not silently unify it |
| Checkpoint 5's `project_agent_memory` grows unbounded on a long-lived project, inflating every future run's prompt and cost | Medium | Enforce a hard per-project cap at write time in `saveProjectMemory`, mirroring the existing prune-on-write precedent already in this codebase (`agentLoopService.ts` snapshot pruning against `agentSnapshot.ts`'s `MAX_SNAPSHOTS_PER_PROJECT`), not a new, unproven eviction design |
| Checkpoint 1's key-derivation change touches the mutation-breaker dispatch gate shared by both `agentLoopService.ts` and `agentToolSet.ts` — a file/function with two prior production incidents | Low-Medium | Add DB-tool key derivation as a strictly additive branch (`deriveDbMutationKey`, checked only for the 3 new tool names); the existing simple field-lookup path for the original 6 file/edge-function tools is untouched. New test asserts existing-tool behavior is unchanged, not just that DB tools now work |
| Checkpoint 3 seeds `ctx.declaredScope` from a read-only investigation of *existing* files; a build/feature-tier run that legitimately needs to create net-new files not yet on disk could see those writes flagged as out-of-scope | Medium | No new mitigation needed: the scope gate is already soft (`SCOPE_VIOLATION_TOLERANCE = 2`, warn-then-block, not a hard block on first touch) and the model's own `declare_scope` escape hatch already handles legitimate expansion — the same mitigation the fix-tier version relies on today. Checkpoint 3's test must add a build-tier "creates new file outside seed" case explicitly, since the existing fix-tier tests only cover editing already-implicated files |
| Checkpoint 6 depends on a fresh investigator dispatch returning usable findings; the same dispatch attempted during design-time grounding this session did not | Low | Not a blocker: if the fresh dispatch again returns nothing usable, checkpoint 6 closes as "no confirmed dead code found" rather than being forced to invent removals to justify the checkpoint |

## Change log

<!-- Populated on first amendment after the spec is approved. Do not log drafting/refinement turns. -->
