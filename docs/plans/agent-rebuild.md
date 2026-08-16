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

## Part 2 — SUPERSEDED

The phase plan that followed here is superseded by the ground-up design in
`docs/plans/agent-v2-architecture.md` (2026-08-16), which incorporates the
industry research pass (Lovable/v0 leaked prompts, bolt.diy/Dyad source,
Aider/SWE-agent evidence) on top of this audit. Part 1 above remains the
authoritative record of the audit findings and is referenced by that design.
