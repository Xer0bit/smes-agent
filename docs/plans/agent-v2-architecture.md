# EcomGear Agent v2 — Ground-Up Architecture

Written 2026-08-16. This is a from-first-principles design, not a patch plan.
It is grounded in two evidence bases:

1. **The internal audit** of the current agent (`docs/plans/agent-rebuild.md`,
   Part 1) — four parallel deep-dives into tools, lifecycle, sync, and cost,
   anchored to the CardPro logo saga ($1.29 / 41 steps / 15.7 min to change
   one logo, breaking the site's header along the way).
2. **Industry research** on how the competitors actually work, read from
   primary sources: Lovable's and v0's leaked system prompts and tool schemas,
   bolt.diy's and Dyad's actual source code, Aider's edit-format benchmarks,
   the SWE-agent interface-ablation paper, and Anthropic's SWE-bench and
   context-engineering write-ups. Source URLs inline.

The current system is not rewritten for its own sake. Where the audit showed a
component is sound (streaming XML protocol, per-project Vite preview, tier
classification, prompt-cache discipline), v2 keeps it. Where every competitor
independently converged on the same answer and we do something else, v2 adopts
the consensus.

---

## 0. Design laws (the evidence, compressed)

Numbered so later sections can cite them as L1..L12.

- **L1 — The filesystem/repo is the state; the transcript is not.** Universal
  (Lovable: real repo; v0: VM with git; Bolt: in-browser FS; Dyad: local FS +
  git checkpoints). Never resend a project; diffs go INTO the prompt, whole
  files come OUT of the model.
- **L2 — Prompt rules don't hold; mechanisms do.** Lovable's prompt forbids
  whole-file rewrites four separate times — reviewers still name "rewrites
  whole files, cascading bugs" as its #1 failure. v0's answer is a
  deterministic AST post-pass plus a small fine-tuned repair model
  (vercel.com/blog/how-we-made-v0-an-effective-coding-agent). bolt.diy's
  answer to scope creep is file locks, not the "only modify requested files"
  clause it also ships.
- **L3 — Edit format is worth 3× and is per-model-family.** Aider: GPT-4 Turbo
  20%→61% by switching format; Gemini needs its own fencing variant. Track
  format-adherence as its own metric (aider.chat/docs/leaderboards/edit.html).
- **L4 — Windowed context beats whole files.** SWE-agent ablation: 100-line
  window 18.0%, full file 12.7% — full file is WORSE than a too-small window
  (arxiv.org/html/2405.15793v2). Rank with a graph, enforce the budget by
  search, not hope (Aider repomap).
- **L5 — Lint/validate every edit mechanically, feed errors straight back.**
  +3.0pp alone in SWE-agent's ablation. Cheapest measured win that exists.
- **L6 — A cheap model selects context and applies edits; the strong model
  reasons.** bolt.diy select-context (hard 5-file cap), Dyad Smart Context +
  Turbo Edits, Aider architect/editor (85% SOTA), RouteLLM (85% cost cut at
  95% quality). Every product travels the arc full-file → cost pain → tiered;
  v2 starts at the endpoint.
- **L7 — Asking must be a first-class action, and it's currently one-sided.**
  Measured across 6,000 real sessions: agents ask in 1.4% of turns while
  users push back in 44% (arxiv.org/abs/2604.20779). v0 ships
  `AskUserQuestions` with a hard never-parallel rule; Lovable waits for the
  answer before any tool call. Counter-rule: on the FIRST message of a fresh
  project, build — don't interrogate (Lovable ships a distinct turn-1 prompt
  tail).
- **L8 — No unbounded auto-repair loops.** Dyad v1.9.0 *deleted* its auto-fix;
  Bolt's fix button is human-gated with docs telling users to stop clicking
  it; Dyad's in-run rule is "retry twice, then change strategy." Verification
  belongs inside the plan as an explicit step, not as a background loop.
- **L9 — Checkpoints are git commits with revert (not reset) semantics.**
  Lovable auto-snapshots every change with per-message restore; Dyad uses
  git-backed per-message checkpoints. Known hole to avoid: code-only restore
  that silently ignores DB state — state the limit loudly if not covered.
- **L10 — Structured compaction with standing preferences and a recovery
  path.** Dyad's compaction carries "a preference stated once, early, still
  binds"; v0 replaces omitted content with "Content omitted to save context —
  re-Read the file to retrieve." Never silently truncate.
- **L11 — Debug tools before source.** Lovable consults console logs and
  network requests as first-class tools BEFORE reading code; v0 namespaces
  debug logs (`[v0] ...`) so they're greppable and auto-removable.
- **L12 — Minimal scaffold, rich tool contracts.** Anthropic's SWE-bench agent
  is two tools with excellent descriptions, no state machine, 49%→77% across
  model generations without scaffold changes.

---

## 1. System overview

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENT (web-client)                                            │
│  chat ─ live narration line ─ preview iframe ─ ask-user cards   │
│  editor (derives from head commit; dirty-file saves only)       │
└───────────────▲───────────────────────────────┬─────────────────┘
                │ SSE (turn events)             │ saves (parent-sha checked)
┌───────────────┴───────────────────────────────▼─────────────────┐
│  TURN PIPELINE (gen server)                                     │
│  Intake → Router → Context Engine → Actor ⇄ Edit Engine         │
│                          │              │                       │
│                          │              └→ Validator (per edit) │
│                          ▼                                      │
│                    Interaction (ask/plan gates)                 │
│  → Finalizer: autofix pass → verify (build+smoke) → COMMIT      │
└───────────────┬─────────────────────────────────────────────────┘
                │ fast-forward push (sha-ordered)
┌───────────────▼─────────────────┐   ┌───────────────────────────┐
│  PROJECT STORE (per-project git)│──▶│  PREVIEW (Vite dev server) │
│  commits = turns = checkpoints  │   │  materialized from HEAD    │
└─────────────────────────────────┘   └───────────────────────────┘
```

Kept from v1: the streaming XML tag protocol, the per-project Vite preview
host, SSE transport, tier classifier, Anthropic cache-prefix discipline,
the narration microservice, the tenant DB/edge-function stack.

Replaced: three diverging truths → one git store; opt-in scope → locks +
auto-scope; context starvation → Context Engine; ≤3-pass repair loop → one
bounded verify; prompt-hoped correctness → deterministic validation.

---

## 2. The Project Store — one truth (L1, L9)

**Every project is a git repository** on the gen server (the per-project
`appPath` dir it already has, `git init`-ed, bare mirror optional later).

- **Every mutation is a commit**: one commit per agent turn (message = the
  user prompt, author `agent`), one commit per client save (author `user`).
- **`revisions` becomes an index of commits** (sha, author, prompt, ts) — the
  existing table and Storage manifests remain as the export/CDN layer, derived
  from commits, no longer independently writable.
- **Client saves are fast-forward-only.** A save carries `base_sha` and only
  *dirty files*. If `base_sha != HEAD`, the server 409s; the client reloads
  HEAD, reapplies its dirty files, retries. This deletes the entire
  clobber-loop class (the 05:27 stale-tab incident) with git's own machinery
  instead of custom concurrency. The full-workspace-map serialize
  (`WorkspaceContext.tsx:90`) is gone: dirty paths only.
- **Preview accepts only fast-forward.** `/preview/:id/update` carries the
  commit sha; the preview refuses to move backwards. `revisionId`/
  `contentHash` already travel on this wire unvalidated — this gives them
  teeth.
- **Restore = `git revert` semantics** (new commit, history preserved —
  Lovable's model). Restore points never expire; the snapshot-dir prune that
  silently nullified `snapshot_id` after 20 runs is deleted along with the
  snapshot dirs themselves.
- **Stated limit (L9):** restore covers code, not the tenant DB. The restore
  UI must say so — Lovable's silent half-restore is a top user grievance.

Migration is shadow-first: commit alongside the existing revision writes for a
week, diff the two stores, then flip authority.

## 3. Context Engine — structural sight on a budget (L4, L6, L10)

Two layers, both hard-budgeted.

**Structural layer (always present, ~2.5K tokens):**
- File tree (exists, 5K-char clamp stays).
- **Route/render map** — new, and the single highest-leverage addition: parse
  App.tsx routes + walk the existing import graph
  (`agentLoopService.ts:740-760`, currently computed and discarded) into
  `route → page → key components`, plus an **"unreachable from App.tsx"**
  list. The logo run would have seen `Header ← Layout ← (NOT ROUTED)` at
  step 1 instead of discovering it at step 15.
- **Asset registry** — `public/assets/` names, sizes, mtimes. No guessed
  filenames, ever.
- Tenant schema summary (exists, minus row counts — already fixed).
- **Standing constraints** — user preferences that survive compaction (L10).

**Task layer (per message):**
- A **cheap selector model** (Gemini Flash — already wired for narration)
  picks ≤6 relevant files from tree + route map + conversation summary
  (bolt.diy's select-context pattern, hard cap enforced server-side).
- Selected files are shown as **~100-line windows** around the relevant
  symbols (L4), not 800-char peeks and not whole files. `read_file` remains
  the escape hatch and its result windows too.
- KB retrieval snippets (top-3, ≤2K tokens) are **injected as text** for
  edit/fix tiers — today they only re-rank.
- Compaction: keep the existing cache-safe batching, add the structured
  summary sections and the v0-style recovery note ("omitted — re-read to
  retrieve") (L10).

## 4. Edit Engine — how code changes land (L2, L3, L5)

**Primary edit tool: `line_replace`** — Lovable's shape, verbatim semantics:
`(path, search, first_line, last_line, replace)` where `search` may elide the
middle with `...` after 2-3 anchor lines each side. Line numbers anchor;
text disambiguates. Parallel edits to one file use *original* line numbers.
This is the direct fix for both the cost of whole-file rewrites and the
cascading-bug failure mode reviewers pin on Lovable-style full rewrites.

- **Two misses → automatic fallback to `write_file`** (Dyad's rule). Never a
  third retry of the same search.
- **`write_file`** stays for new files; for existing files it accepts
  `// ... keep existing code` markers spliced deterministically server-side
  (Lovable's mechanism), so even the fallback doesn't pay full-file output.
- **Per-model format table** (L3): Anthropic and Gemini get formats proven for
  their family; **format-adherence is logged per run** as its own metric,
  separate from task success.
- **Every accepted edit is validated mechanically** (L5): esbuild/TS syntax
  parse (exists in write_file today) + ESLint pass, error text returned to the
  model verbatim in the tool result. Byte-identical no-op writes already
  bounce (shipped).
- **Deterministic finalize autofix** (L2, v0's pattern): before verify, a
  non-LLM pass fixes the top recurring breakages — unresolved imports
  (create-or-drop per Dyad's pre-flight audit), undeclared dependencies
  (auto-add to package.json), unknown lucide icon names (nearest-match),
  missing provider wrappers. Each fix is logged into the commit message.

**Scope enforcement (L2 — mechanism, not prompt):**
- **Auto-seeded scope** for micro/edit/fix: the selector's file list IS the
  initial `declaredScope`. Not model-volunteered.
- **The gate covers every mutating tool** — including
  `replace_asset_references` (today: zero guards), `place_asset`,
  edge-function and DB tools, `run_command` installs.
- **Tolerance 0** for micro/edit (today: 2 free violations). Widening scope
  is one explicit `declare_scope` call naming files and reason — the gate
  stays hard because the escape hatch is cheap.
- **Locks**: user-lockable files/folders in the editor UI (bolt.diy), plus
  system-privileged paths — `App.tsx`, `main.tsx`, `Layout.*`, `index.html`
  can only enter scope by explicit declaration, never by selector side effect.
- Real caps for feature/build (today: uncapped).

**Assets (deterministic):**
- `place_asset` dedups by content hash; the server names the file
  (slug + short hash) — the model's destName is a hint. Re-upload of the same
  logo returns the existing path. One canonical ordering (place → replace
  refs → delete), stated once; the current prompt/tool contradiction deleted.

## 5. Interaction — ask, plan, act (L7)

- **`ask_user` tool.** Pauses the run in a new `needs_input` state; SSE event
  renders a question card with quick-reply chips; run resumes on answer;
  10-min timeout ends the turn gracefully (not an abort, work-so-far
  committed). Never called in parallel with other tools (v0's rule). Exempt
  from the phantom-narration abort — asking must not be punished.
- **When to ask** (prompt, one rule, no contradictions): missing *input* the
  model cannot invent — an asset, a credential, a choice between two named
  targets — → ask. Missing *decision* with a sane default → act and state the
  assumption in one line. The current "Do NOT ask for confirmation … ask one
  short question" self-contradiction is deleted.
- **Turn-1 override**: first message on an empty project builds immediately
  (Lovable's split prompt tails).
- **Plan gate for feature/build only**: an architect pass (strong model,
  prose) streams the plan; edit/fix/micro act directly (Cline Plan/Act shape,
  Aider architect/editor economics — L6). The plan is where the user redirects
  *before* 30 files change, replacing per-action approval.
- Narration: the live one-line status (shipped) + a ≤2-sentence postamble.
  The "AT LEAST N sentences / FORBIDDEN under 15 words" floors are deleted —
  they manufacture the padded triple-repeat summaries users hate.

## 6. Verification — done means verified (L8, L11)

- **In-run**: per-edit lint (L5); `get_build_errors` stays; debug-tools-first
  ordering — the preview already injects console/error capture
  (`error-reporter.js`), surface it as `read_console_logs` and instruct its
  use BEFORE reading source on any "it's broken" prompt (L11). Agent debug
  logging is namespaced `[ecg]` for greppable auto-removal.
- **Finalize**: build check (exists) → **smoke the route that renders the
  touched components** — the route map makes "which route" a lookup; today's
  smoke only visits the root. Console errors captured during smoke feed the
  single bounded fix pass.
- **One bounded repair pass, then stop and surface** (L8): replaces today's
  ≤3 LLM repair passes. On failure after one pass: commit what's healthy,
  report exactly what's broken with a one-click "fix this" that starts a NEW
  visible turn. No invisible token burn.
- **A run may report success only as its verified level**: `verified`
  (pushed + smoke-passed on touched routes) / `pushed` / `no-change` /
  `failed`. The dashboard's "completed" today means none of these.
- **Honest metrics**: per-write before/after content hashes make
  `net_new_write_count` real (today: dead — 349/352 runs read 0);
  format-adherence rate; ask rate; and the north star: **cost per verified
  change** (the logo saga: $1.29/0 verified; target < $0.10/1).

## 7. Cost governor (L6)

Mostly falls out of the above — wasted steps were the cost anomaly, not
expensive steps ($0.35 vs $0.025 per file written on otherwise-similar runs).
Mechanical dials on top:
- Tier-scaled `GEMINI_THINKING_BUDGET` (flat 2048 today; ~90% of billed
  output on the measured run was thinking): micro/edit 512, fix 1024,
  build 2048.
- `COMPACT_AFTER_STEP` 6 → 3 for edit tier (transcript is ~20K of the 46K
  per-step context), keeping the cache-safe 4-step batching.
- Architect/editor routing (L6): strong model plans feature/build; editing and
  context selection run on cheap models. RouteLLM-style thresholding later,
  only if per-tier routing proves insufficient.
- Existing $1.50 run cap and token caps stay.

---

## 8. Migration map

Each stage ships alone, ordered by user pain; the audit's earlier phase plan
(agent-rebuild.md Part 2) is superseded by this map.

| # | Stage | Contents | Size |
|---|---|---|---|
| M1 | **Stop the reverts** | Git store in shadow mode → dirty-file saves with base_sha + 409/rebase → fast-forward preview pushes → flip authority | M/L |
| M2 | **Sight + asking** | Route/render map, asset registry, selector-picked 100-line windows, injected retrieval text; `ask_user` + needs_input state + turn-1 override; delete contradictory prompt lines | M |
| M3 | **Hard scope** | Auto-seed from selector, all-tools gate, tolerance 0, privileged paths, locks UI, feature/build caps | S/M |
| M4 | **Edit engine** | `line_replace` with ellipsis + per-model formats + 2-miss fallback + keep-existing-code splice + per-edit lint + format-adherence metric | M |
| M5 | **Deterministic finalize** | Import/dep/icon autofix pass; asset dedup + server naming; one-ordering fix | S |
| M6 | **Verified done** | Touched-route smoke, console-capture surfacing, one bounded repair pass, verified levels in run records, honest metrics | S/M |
| M7 | **Cost dials** | Thinking budgets, compaction threshold, architect/editor routing | XS/S |

Acceptance test for the whole build — replay the logo saga:
1. "use the correct logo" with no attachment → one question, zero writes, <$0.02.
2. Attach logo → place (deduped name) + one reference edit inside auto-scope;
   App.tsx untouchable; route-smoke verifies the header renders; ≤$0.10, ≤90s.
3. A stale tab's save 409s and rebases instead of resurrecting broken code.
4. Any prior message restorable a week later.

## 9. Deliberately avoided (the competitors' scars)

- Whole-file rewrite as default edit path (Lovable's #1 complaint).
- Unbounded auto-fix loops (Dyad deleted theirs; Bolt human-gates).
- Blocking clarification as the default (Lovable's discussion-mode fatigue) —
  ask only for un-inventable input; turn-1 always builds.
- Silent code-only restore (state the DB limit in the UI).
- Charging full price for reverted work — out of scope here, but flag for
  billing: Lovable's top grievance.
- Trusting the injected context block (ship the search escape hatch beside it).
- Prompt-only correctness anywhere a mechanism can exist.
