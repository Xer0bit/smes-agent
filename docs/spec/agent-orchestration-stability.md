# Agent orchestration stability

## Goal

Make the website-building agent's loop grounded in real signals: every
user-visible success claim backed by a real check, every failure surfaced in
plain language, change confined to a declared scope on fix tier, and the
platform alerted on provider outage. Six independently-shippable checkpoints on
the existing single-writer loop.

## Non-goals

- No multi-agent concurrent writes. One `streamText` loop owns all mutation
  tools; any added pass is read-only.
- No rewrite of the loop, tier concept, snapshots, or prompt caching.
- No full e2e / visual-diff verification (the binary browser smoke check stands).
- No isolated-vm port for VPS5 (tracked separately as the complete S4 fix).
- No re-implementation of G1/G7/G2/G3/S4 (shipped this session; foundation).
- No retrieval *enforcement* until the skip rate is measured (CP4a gates CP4b).

## Success criteria

- [ ] A fix-tier run that ends unhealthy shows the user a plain-language
      explanation of what broke and one next action, never bare "Cancelled."
      or an unbacked "Fixed!".
- [ ] A sustained provider failure (auth/billing/outage) raises an alert to the
      configured sink within one health-loop cycle, with zero code change to
      trigger it — verified by simulating a failing provider.
- [ ] On fix tier, a write to a file outside the declared scope warns, and a
      sustained pattern of out-of-scope writes blocks — verified on a fixture
      reproducing the logo incident (declares logo file, attempts unrelated
      edits, asserts warn-then-block; a legit multi-file dependency edit within
      scope asserts zero false blocks).
- [ ] The fix-tier declared scope is seeded automatically from the read-only
      diagnosis pass, not left empty — verified by asserting `ctx.declaredScope`
      is populated before the first write on a fix run.
- [ ] Retrieval skip rate is measured on live runs and reported (CP4a); a
      retrieval nudge/gate ships only if the measured rate justifies it (CP4b).
- [ ] The per-run system prompt for a micro/fix/edit request is materially
      smaller than today's, loading only the sections that tier needs, with no
      loss of the component manifest / installed-package list — verified by
      byte-size comparison and a build-still-works smoke run per tier.
- [ ] A misclassified run can be re-tiered mid-flight when it discovers more
      work than its budget allows, bounded by the existing USD cap — verified by
      a fixture that starts micro and escalates.

## Approach

Harness-enforced, incremental: each axis becomes a mechanical, real-signal-gated
gate in the existing single loop, shipped one checkpoint at a time — see
`docs/design/agent-orchestration-stability.md`.

## Change tree

```
apps/api-gateway/src/
├── services/
│   ├── agentLoopService.ts ........... M  (honest-failure surfacing; scope seed from diagnosis; re-tier hook)
│   ├── llm-health.service.ts ......... M  (emit alert on provider disable)
│   ├── alerting.service.ts ........... A  (new: alert sink dispatch)
│   ├── intentClassifier.ts ........... M  (mid-run re-tier signal)
│   └── agentToolSet.ts ............... M  (scope gate: warn→block on fix tier)
├── agent-tools/
│   ├── declare_scope.ts .............. M  (enforced on fix tier, not opt-in)
│   ├── types.ts ...................... M  (AgentContext: retrievalConsulted, retiered flags)
│   └── search_codebase.ts ............ M  (retrieval-consult telemetry, CP4a)
├── prompts/
│   └── app-builder.prompt.ts ......... M  (section chunking by tier; honest-failure copy)
└── routes/
    └── ai.routes.ts .................. M  (stream honest-failure + verification result to client)
docs/design/agent-orchestration-stability.md .. A  (design)
docs/spec/agent-orchestration-stability.md .... A  (this spec)
```

## Outline

apps/api-gateway/src/services/alerting.service.ts
  AlertingService — dispatch a structured alert to the configured sink
    dispatch — send one alert (provider, reason, severity) to the sink
    isConfigured — whether a sink is set (no-op when unset)

apps/api-gateway/src/services/llm-health.service.ts
  provider-disable hook — emit an alert when a provider is auto-disabled

apps/api-gateway/src/services/agentLoopService.ts
  honest-failure surfacing — replace bare cancel / false-success with plain-language state + next step
  scope seed — populate ctx.declaredScope from the diagnosis pass on fix tier
  re-tier hook — detect budget-vs-discovered-work mismatch, raise tier within USD cap

apps/api-gateway/src/services/agentToolSet.ts
  scope gate — on fix tier, warn on first out-of-scope write, block on sustained pattern

apps/api-gateway/src/agent-tools/declare_scope.ts
  fix-tier enforcement — scope no longer opt-in on fix tier

apps/api-gateway/src/agent-tools/search_codebase.ts
  consult telemetry — record whether retrieval ran before a net-new write (CP4a, measurement only)

apps/api-gateway/src/prompts/app-builder.prompt.ts
  tier section chunking — load only the sections a tier needs, keep component manifest
  honest-failure copy — plain-language failure templates

apps/api-gateway/src/routes/ai.routes.ts
  stream verification result — surface the browser/test result and honest-failure to the client

## Flows

Flow: honest failure (CP1)
1. repair loop exhausts on a fix-tier run
2. loop composes a plain-language statement: what broke (from the real error),
   what the user can do next
3. `ai.routes.ts` streams that statement instead of "Cancelled." / silent stop

Flow: provider-outage alert (CP2)
1. `llm-health.service.ts` health cycle marks a provider failing and disables it
2. it calls `alerting.service.dispatch({provider, reason, severity})`
3. the sink receives the alert within one cycle; no operator code change needed

Flow: scoped fix (CP3)
1. fix-tier run starts; read-only diagnosis pass names the implicated file(s)
2. `ctx.declaredScope` is seeded from those file(s) before the first write
3. a write inside scope proceeds; a write outside scope warns, then blocks after
   the tolerance is exceeded

Flow: retrieval measurement (CP4a)
1. agent is about to create a net-new file/symbol
2. telemetry records whether a retrieval tool (`search_codebase`/grep/glob) was
   consulted earlier in the run
3. the skip rate is aggregated for the enforce-vs-nudge decision (CP4b)

Flow: mid-run re-tier (CP6)
1. a micro/fix run discovers the change needs more steps than its budget
2. the re-tier hook raises the tier (and budget) once, bounded by the USD cap
3. the run continues under the higher budget instead of stalling out of steps

## Checkpoints

| # | Checkpoint | Files/areas | Agent | Est. files | Verifies |
|---|------------|-------------|-------|------------|----------|
| 1 | Honest failure surfacing: plain-language what-broke + next step, replacing bare "Cancelled." / unbacked "Fixed!" | `agentLoopService.ts`, `app-builder.prompt.ts`, `ai.routes.ts` | atomic-implementer (mode: feature) | ~3 | Fixture: exhausted fix run streams a plain-language failure with a next step; healthy run unchanged |
| 2 | Alerting on provider disable | `alerting.service.ts` (new), `llm-health.service.ts` | atomic-implementer (mode: feature) | ~2 | Simulated failing provider raises one alert to the sink within a cycle; unset sink is a no-op |
| 3 | Declared scope enforced on fix tier, seeded from diagnosis | `declare_scope.ts`, `agentToolSet.ts`, `agentLoopService.ts`, `types.ts` | atomic-implementer (mode: feature) | ~4 | Logo-incident fixture: warn-then-block out of scope; in-scope multi-file edit zero false blocks; `ctx.declaredScope` populated pre-write |
| 4a | Retrieval-consult measurement (telemetry only, no gate) | `search_codebase.ts`, `types.ts`, `agentLoopService.ts` | atomic-implementer (mode: surgical) | ~2 | Skip rate recorded per run and readable in aggregate; zero behavior change |
| 4b | Retrieval nudge/gate — **only if CP4a data justifies** | `app-builder.prompt.ts` and/or `agentToolSet.ts` | atomic-implementer (mode: feature) | ~2 | Contingent on CP4a; nudge fires before net-new write when retrieval was skipped; no false block on genuine net-new |
| 5 | Prompt section chunking by tier | `app-builder.prompt.ts` | atomic-implementer (mode: feature) | 1 | Per-tier byte size drops vs today; component manifest retained; build-works smoke per tier |
| 6 | Tier routing robustness + mid-run re-tier within USD cap | `intentClassifier.ts`, `agentLoopService.ts` | atomic-implementer (mode: feature) | ~2 | Fixture starts micro, discovers more work, escalates once; USD cap still bounds it |

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| A scope gate false-blocks a legit multi-file dependency edit | med | Warn-then-block with tolerance (not block-on-first); fix tier only; seeded from diagnosis so the common surface is pre-declared; CP3 fixture asserts zero false blocks on a real multi-file edit |
| A retrieval gate blocks genuine net-new code | med | CP4a measures before CP4b enforces; ship as a nudge first, gate only if data demands; never block, only prompt |
| Prompt chunking drops a section a tier silently needs | med | Per-tier build-works smoke run in CP5; component manifest + installed-package list explicitly retained (the #1 cause of fix loops per existing prompt comments) |
| Mid-run re-tier causes cost blowout | low | Bounded by the existing USD cap; single escalation per run; conservative trigger |
| Alert sink noise (flapping provider) | low | Alert on state transition (healthy→disabled), not per-failure; dedupe within a cycle |
| Session/account limits stall the implementation loop | med | Checkpoints are independent and small; implement one per available window; none blocks another except CP4b→CP4a |

## Change log

<!-- Populated on first amendment after the spec is approved. Do not log drafting/refinement turns. -->

## Implementation log

### shipped — 2026-08-13

Built across 6 iterations of `/subagent-implementation`. Commits (chronological):

- `5e54d66` — CP1: don't claim success when a browser smoke check found a broken render
- `b4c9486` — CP2: alert on LLM provider disable, transition-only, never blocks the health check
- `1b05ab4` — CP3: verify the pre-existing declared-scope gate + diagnosis seeding (no production code changed)
- `d9358df` — CP4a: measure retrieval-consult skip rate before writing new code (telemetry only)
- `3b78b5f` — CP5: guard the prompt-chunking mechanism against silent heading-mismatch drift; wire two dead build-tier flags
- `93bf9c7` — CP6: auto-continue a step-capped run that made real progress
- `e51ad91` — followup F-1: defend the alert dispatch call site, not just `dispatch()` itself

**Out-of-scope work performed during this build:**

- None. Every commit stayed within its checkpoint's declared file set;
  each brief explicitly fenced off every other checkpoint's files and no
  reviewer found a violation.

**Unforeseens — surprises that emerged during implementation:**

- CP3's entire production mechanism (the `declare_scope` tool, the
  warn-then-block gate, the diagnosis-seeding integration) already existed
  from a prior session's work — none of it had ever been tested. Reframed
  the checkpoint from "build the gate" to "prove the already-built gate
  does what it claims"; shipped as a test-only commit.
- CP6's spec described dynamically raising the step/token budget mid-run.
  Traced the actual control flow and found that would require
  reconfiguring the AI SDK's `stopWhen` mid-stream — high risk on the core
  loop. Found a smaller, already-proven path instead: the existing
  `needsAutoContinue` mechanism only triggered on a token/cost-cap hit,
  never on the plain step-count ceiling, even when a run had made real
  progress. Widened one condition instead of building new machinery.
- An implementer's attempt to get a local test environment running
  (mid-CP1) symlinked package directories from the main checkout instead
  of doing a proper install; `npm install` wrote through those symlinks
  into the shared main checkout's `node_modules`, corrupting 160 packages.
  Independently verified by the orchestrator (spot-checked content,
  counted affected dirs, confirmed no concurrent process was touching the
  directory), user explicitly confirmed the restore before it ran, then
  independently re-verified via `node -e require.resolve(...)` against the
  real module resolver. A separate, unrelated pre-existing gap
  (`@testing-library/dom` declared in the lockfile but never actually
  installed even before the incident) was found and fixed scoped to the
  worktree only.
- A CP2 reviewer used `git stash` despite an explicit instruction not to
  (shared stack across other worktrees on this machine). No harm this
  time (`git stash list` confirmed empty immediately after), but every
  subsequent reviewer/implementer dispatch repeated the constraint more
  forcefully; no further occurrence.

**Deferred items still open:**

- **CP4b (retrieval nudge/gate)** — explicitly contingent on CP4a's
  measured skip rate. No live data exists yet since CP4a just shipped;
  not started, per the spec's own non-goal.
- F-1 and F-2 (the only two non-blocking findings raised across all 6
  checkpoints) were both dispositioned at finalization — F-1 fixed
  (`e51ad91`), F-2 dropped. No open follow-ups remain.
