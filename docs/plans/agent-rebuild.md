# Agent Rebuild — Lovable-Class Reliability

Written 2026-08-16 after a four-way architecture audit (tools, lifecycle, sync,
cost) plus two days of production incidents. Every claim below carries a
file:line or a production run id. The audit reports' full text lives in the
session that produced this; the load-bearing findings are inlined here so this
document stands alone.

**The benchmark incident** (use it to test every phase): the CardPro logo saga,
2026-08-16 04:49–05:53. Four runs, 41 steps, 15 file writes, 15.7 min, $1.29,
to change one logo. Along the way the agent guessed at a missing asset, edited
9 files on a one-file request, dropped `<Route element={<Layout />}>` from
App.tsx (header vanished site-wide), flip-flopped between two logo filenames,
edited a component that was no longer rendered for 15 steps, and had its
server-side fix silently overwritten by a stale browser tab's auto-save.
A rebuilt agent must make each of those failures *structurally impossible*,
not prompt-discouraged.

---

## Part 1 — What the audit established (the "learn the agent" half)

### 1.1 Sources of truth: there are three, and none wins

- Preview disk (VPS2), DB revisions + Storage, and each open tab's in-memory
  WorkspaceManager map diverge independently. No ordering between them.
- A client save serializes the tab's **entire** workspace map, not dirty files
  (`WorkspaceContext.tsx:90`), as a plain INSERT with no parent-revision check
  (`revisionService.ts:149`). Last writer wins unconditionally.
- A tab that merely sits open can save: the chat panel's mount effect rejoins
  an active run and its `onDone` → `onFilesGenerated` →
  `saveWorkspaceWithCarry()` (`Editor.tsx:2298,2516`) — immediate, un-debounced.
- `revisionId`/`contentHash` already travel on the preview wire and are
  **validated against nothing** (`preview-service/server.js:1886` — "not
  required, not validated, not used").
- Every editor open pushes the latest DB revision over preview disk
  unconditionally (`Editor.tsx:1023-1042`), so whatever reached the DB last
  silently wins the preview.
- Proven consequence: the 05:27 "Auto-saved workspace changes" revision
  resurrected broken code over a live fix; only patching the DB revision row
  itself stuck.

### 1.2 The model is context-starved and structure-blind

- Edit-tier context on a ~190-file project: **4 files max, 800 chars each**
  (8K total; 3K if the prompt names the file) — `agentLoopService.ts:873-925`.
  ~186 files contribute only a path in a 5K-char ASCII name tree.
- Signature previews for 40 more files; nothing for the rest.
- KB retrieval output is used **only as a ranking bonus** to pick the 4 files
  (`:832-848`); retrieved text is never injected.
- **Nowhere** is the model told which components are routed/rendered. The
  import graph is computed (`:740-760`) but only sorts the 4 files. Route
  knowledge is prose rules in the prompt. This is the direct cause of 15 steps
  spent fixing a logo path in a Header that nothing mounted.

### 1.3 Asking the user is structurally impossible

- 33 tools; none asks the user anything. No run state means
  "waiting for input".
- The edit-mode instruction contradicts itself in one paragraph:
  "Do NOT ask for confirmation. … If intent is unclear, ask one short
  question" (`agentLoopService.ts:1513`).
- The phantom-narration abort (`:2337`) punishes steps that produce text
  without tool calls — so asking is actively penalized. "Use the correct
  logo" with no logo attached therefore produces guessing, every time.

### 1.4 The scope gate is opt-in Swiss cheese

- Gate covers only write_file/edit_file/delete_file/rename_file
  (`agentToolSet.ts:452-458`), tolerates 2 violations, and only exists if the
  model volunteers a `declare_scope` call.
- Uncovered mutating tools: **replace_asset_references (project-wide rewrites,
  zero guards)**, place_asset, run_command, write_edge_function,
  confirm_edge_function_deploy, delete_edge_function, set_secret,
  query_database/confirm_database_change/provision_database, push_to_github,
  publish_site.
- `TIER_FILE_CAPS = { micro: 3, edit: 10, fix: 10 }` — feature and build have
  **no cap** (`agentToolSet.ts:135`).
- Caps are duplicated (`intentClassifier.ts:78` vs `agentLoopService.ts:305`)
  with a stale header comment — two sources of truth in the codebase itself.

### 1.5 The asset pipeline invites the flip-flop

- No content-hash dedup: the same logo uploaded twice = two files. The model
  may pass ANY destName (the sanitized suggestion is not enforced) —
  `place_asset.ts:98`, `agentLoopService.ts:1051,1146`.
- The system prompt orders delete→place→edit while the tool docs order
  place→replace→delete (`app-builder.prompt.ts:1224` vs `place_asset.ts:75-79`)
  — contradictory instructions on the exact operation that failed.

### 1.6 Rollback silently expires

- Snapshot is fire-and-forget and races the run's own writes
  (`agentLoopService.ts:1785`).
- The prune pass nullifies `snapshot_id` on older runs beyond 20
  (`:4691-4694`) — restore points quietly vanish with no user-visible signal.

### 1.7 Cost anatomy (measured on the 949K-token run)

- ~46K tokens context/step: ~25K fixed floor (13.6K edit system prompt +
  ~6K tool defs + ~5K dynamic) + ~20K accumulated transcript
  (`COMPACT_AFTER_STEP = 6`, so steps 1–5 never compact).
- **Output is 3% of tokens but 40% of cost**, and ~90% of it is Gemini
  thinking tokens at a flat `GEMINI_THINKING_BUDGET = 2048` per step for
  every tier (`agentLoopService.ts:1950`). Narration ≈ 1%.
- Cost is near-linear in step count. The anomaly is 20 steps for a logo, not
  expensive steps. **Behavioral fixes are the cost fixes.**
- Per-file cost spread on real runs: $0.025 → $0.35 (14×) purely by step waste.

### 1.8 Already fixed in the last 48h (don't redo)

Type errors no longer gate preview health / repair loop; typecheck off the
response path; 85% spurious Vite restarts; no-op (byte-identical) writes
rejected and counted as non-progress; unfulfilled-promise regex widened;
`npm install` counts as progress; prompt-cache prefix stabilized (single build
prompt variant, row_count removed); attachment persistence + tempPath
confinement; 502 passthrough; nginx `/packages` route.

---

## Part 2 — The phases

Ordered by user pain. Each independently shippable, each with acceptance
criteria tied to the benchmark incident. Later phases assume earlier ones.

### Phase 1 — One source of truth (kills "my fix reverted itself")

The DB revision chain becomes canonical; everything else derives from it.

1. **Optimistic concurrency on client saves.** Every save carries
   `parent_revision_id`; the API rejects a save whose parent is not the
   current head (409), and the client then rebases: reload head, reapply only
   its *dirty* files, retry. Requires tracking dirty paths (WorkspaceManager
   already has per-file source/dirty metadata) — stop serializing the whole map.
2. **Preview push validates freshness.** `/preview/:id/update` rejects (409)
   any full-sync whose `revisionId` is older than the last one it accepted per
   project. Fields already on the wire; enforcement is the missing half.
3. **Rejoin cannot save stale state.** After a stream rejoin, the workspace
   must re-sync from the head revision before any save is permitted.
4. Editor open-push only fires when preview `contentHash` ≠ head revision's
   hash (both already computed).

Acceptance: with a stale tab open on the project, an agent run's change
survives a keystroke in that tab. The 05:27 clobber becomes reproducibly
impossible.

### Phase 2 — Ask-first + structural sight (kills guessing and blind edits)

1. **`ask_user` tool.** Pauses the run (`status: needs_input`), emits an SSE
   event the client renders as a question with quick-reply chips, resumes on
   answer, times out to a graceful stop (not an abort). Exempt from the
   phantom-narration abort. Prompt guidance: missing *input* (an asset, a
   choice between ambiguous targets) → ask; missing *decision* the model can
   default → proceed and state the assumption. Delete the contradictory
   "Do NOT ask for confirmation" line.
2. **Route/render map in context.** From the already-built import graph +
   App.tsx route parse, inject ~1K tokens: routes → page → key components,
   plus an "unreachable from App.tsx" list. The logo run would have seen
   "Header: rendered by Layout; Layout: NOT reachable from App.tsx" at step 1.
3. **Asset registry in context.** List `public/assets/` (name, size, mtime) so
   filenames are never guessed.
4. **Retrieval injects text.** For edit/fix tiers, top-3 retrieved snippets
   (capped ~2K tokens) instead of ranking-only.

Acceptance: "use the correct logo" with no attachment yields one question,
zero writes, <$0.02. An edit to an unreachable component warns the model
before the first write.

### Phase 3 — Hard scope (kills the 9-file logo edit)

1. **Auto-seed scope for edit tier** the way fix tier already does
   (diagnose pass → `ctx.declaredScope`), from prompt + retrieval + route map.
   Not model-volunteered.
2. **Gate covers every mutating tool**, including replace_asset_references,
   place_asset, run_command's installs, edge-function and DB tools.
3. **Tolerance 0 for micro/edit** (currently 2 free violations). Widening
   scope requires an explicit `declare_scope` call naming the extra files and
   why — that call is the escape hatch, so a hard gate stays workable.
4. **Structural files are privileged**: App.tsx, main.tsx, Layout.* require
   scope that names them explicitly; never enter scope via auto-seed side
   effect.
5. Single source for tier caps; give feature/build real caps (e.g. 40).

Acceptance: replay of "use this logo" cannot write App.tsx; total files
touched ≤ scope; a scope violation is visible in the run record.

### Phase 4 — Deterministic assets

1. `place_asset` dedups by content hash — re-upload of identical bytes returns
   the existing path. Server chooses destName (slugged original name +
   short hash); model's destName is a hint only.
2. One canonical ordering everywhere (place → replace refs → delete old);
   fix the prompt/tool contradiction.
3. `replace_asset_references` becomes scope-aware and reports per-file diffs.

Acceptance: uploading the same logo twice yields one file; a logo swap is
place + one reference rewrite, no filename flip-flop possible.

### Phase 5 — Durable checkpoints (kills silent rollback expiry)

1. Await the snapshot before the first write (no racing).
2. Prune may delete snapshot *dirs* but must never null the last-known-good
   run's `snapshot_id`; better: fold checkpoints into the revision chain
   (revisions are already durable + manifest-deduped) and mark
   `checkpoint: true` per run. The existing rollback route then restores from
   revisions, not disk dirs that expire.
3. Client "Restore" per agent message uses that (`/api/v1/ai/rollback` exists
   and works — `ai.routes.ts:1551`; NB: that file contains NUL bytes, grep it
   with `-a`).

Acceptance: any run in the visible history can be restored a week later.

### Phase 6 — Cost & latency dials (after behavior, cheap and mechanical)

1. Tier-scale `GEMINI_THINKING_BUDGET` (flat 2048 today): micro/edit ~512,
   fix ~1024, build 2048. Measured: ~26% of the benchmark run's cost and ~65%
   of serial per-step generation.
2. `COMPACT_AFTER_STEP` 6 → 3 for edit tier (keep KEEP_RECENT_STEPS=4
   batching — it protects the Anthropic cache prefix).
3. Re-check narration minimum-length mandates (`:1331-1334,1513`): drop the
   "AT LEAST N sentences / FORBIDDEN under 15 words" floors; keep the
   one-line-per-file narration.

Acceptance: benchmark-shaped edit run lands under $0.10 and under 90s.

### Phase 7 — Done means verified

1. After an edit-tier run, verify the *route that renders the touched
   component* (smoke gate exists; point it at the right page instead of only
   the root).
2. A run may claim success only with `previewPushOk && smoke-verified`; the
   client toast already distinguishes this (smokeFailureSurvivedRepair) —
   extend to the run record so the dashboard's "completed" means verified.
3. Fix `net_new_write_count` (dead: 349/352 runs = 0) with a real
   before/after content hash per write, so the honesty metrics from Phase 0
   of the last 48h actually measure.

Acceptance: a run that changed nothing user-visible cannot show as a
successful edit anywhere.

---

## Sequencing & effort

| Phase | Size | Risk | Depends on |
|---|---|---|---|
| 1 Source of truth | M (client+preview+API) | Medium — touches save path | — |
| 2 Ask + sight | M (new tool + context) | Low | — |
| 3 Hard scope | S/M | Medium — false blocks possible; escape hatch mitigates | 2 (route map feeds auto-seed) |
| 4 Assets | S | Low | 3 helpful |
| 5 Checkpoints | S | Low | — |
| 6 Cost dials | XS | Low | best after 2–3 |
| 7 Verified-done | S | Low | — |

Phases 1 and 2 are the ones users feel immediately and can start in parallel.
Nothing here rewrites the loop wholesale: the audit showed the loop's guards
are individually sound — they're just opt-in, blind, or contradicted by the
prompt. The rebuild is: make truth single, make sight structural, make scope
mandatory, make done verified.

## Explicitly out of scope

- Model swaps / provider work (Anthropic is currently billing-disabled — an
  ops task, not architecture).
- Multi-agent orchestration, plan-mode UX, template system.
- The 12 financial tables' CASCADE gap, anon-role grants on tenant tables
  (tracked separately — security queue).
