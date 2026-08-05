# The App-Builder Agent Loop

How `server/src/services/agentLoopService.ts` turns a chat message into real file
changes in a user's project. This is the core of EcomGear — not a single LLM
call, a multi-step tool-calling loop (`runAgentLoop()` / `_runAgentLoopInner()`,
~3500 lines).

## 1. Request tiering drives everything downstream

`server/src/services/intentClassifier.ts` classifies every incoming request into
a `requestTier`: `micro`, `fix`, `edit`, `feature`, or `build`. That tier sets
the step budget (must match `TIER_MAX_STEPS` in `intentClassifier.ts`):

```
micro:   8 steps   — trivial one-line asks
fix:    28 steps   — bug fixes (reads get_build_errors first, skips KB retrieval)
edit:   25 steps   — targeted changes to existing code
feature: 35 steps  — new feature work
build:  45 steps   — full app builds from scratch
```

Legacy fallback (no tier provided): 45 steps if the prompt looks like a website
build or is >600 chars, else 25.

The tier also gates retrieval depth (see §2) and token caps per step — the loop
tracks cost against a **$1.50 USD hard cap** as the ultimate backstop regardless
of token math.

## 2. Initial context: hybrid retrieval, not a full-repo dump

Before the first model call, the loop assembles a small, ranked "working set" of
files (`agentLoopService.ts:~600-730`) — explicitly commented as **"GitHub
Copilot-style context selection: small focused working set — agent uses
read_file/list_files tools to pull anything else it needs."** This is a
deliberate choice: the seed context is small, and the agent's own tools are the
real retrieval mechanism for anything beyond it.

Four signals are scored and merged per file:

| Signal | Weight | Notes |
|---|---|---|
| Directly mentioned in the prompt (filename match) | 100 | `directlyMentioned` set |
| Always-critical files | 60 | `src/App.tsx`, `src/index.css`, `src/lib/utils.ts`, `package.json` |
| 1-hop import graph (imports/importers of a mentioned file) | — | skipped for `micro` tier |
| Vector KB retrieval (`retrieveRelevantFiles()`) | score × 80 | skipped for `micro` and `fix`; race'd against a **2s hard timeout** so a slow KB never blocks the request |

Files sort by total score, then get greedily packed into a hard budget:
- `AI_MAX_CONTEXT_FILES` (default 4)
- `AI_MAX_CONTEXT_CHARS` total (default 8000)
- `AI_MAX_FILE_CONTEXT_CHARS` per file (default 800), or
- `AI_MAX_MENTIONED_FILE_CONTEXT_CHARS` (default 3000) if the file was directly named

Anything cut gets a stub note (`"peek only — call read_file(...) before editing"`)
so the model knows to fetch it explicitly rather than assuming it has the full
file.

## 3. The static system prompt

`server/src/prompts/app-builder.prompt.ts` holds the bulk of the system prompt.
`agentLoopService.ts` layers a **Runtime Mode Instruction** on top when in BUILD
mode with hard behavioral rules, notably:

- **Phased build detection**: if the conversation history contains a `## Phases`
  plan, the agent must count `"Phase N done ✓"` markers to know which phase it's
  currently on, and build ONLY that phase's files.
- **No partial builds**: in non-phased build mode, it must write every file the
  app needs — pages, components, utilities, AND `src/App.tsx` — before
  stopping. A partial build is explicitly treated as a failure mode.
- **No hedging language**: forbidden to say "I didn't make any changes" or a
  future-tense promise ("I'll implement that") without immediately following it
  with real tool calls in the same response.
- **Two narrow exceptions** where the agent should NOT write files: a pure
  greeting/identity question, or a genuinely ambiguous request with no
  identifiable build content — in which case it asks one clarifying question
  instead of inventing a task.

## 4. Per-step compaction (`server/src/services/agentContextCompaction.ts`)

A separate, dedicated module — the "context optimizer." Runs before every step
once `stepNumber >= COMPACT_AFTER_STEP` (6).

- **`KEEP_RECENT_STEPS = 4`**: the last 4 steps stay fully intact. Everything
  older gets compacted. (Raised from 2 → 4 on 2026-07-20 after a 2-step window
  was found to compact `read_file` results out of context mid-investigation,
  forcing wasteful re-reads.)
- **Tool-aware compaction, not blind truncation**:
  - `write_file` content → `"[compacted] N lines written to X — see Run Change Journal"`
  - `edit_file` diffs → collapsed to just the search snippet
  - `read_file` results → one-line stub, UNLESS a later step touched the same
    path again, in which case it says `"superseded — see later version in this
    run"` instead of just erasing it (tracked via `buildFileTouchMap()`).
  - `grep`/`list_files`/`get_build_errors` results are truncated to 200-400 chars.
- **Cache-prefix stability was a deliberate rewrite target.** The compaction
  boundary only advances in `KEEP_RECENT_STEPS`-sized batches, not every single
  step. Recomputing the boundary fresh each step meant a *different* message
  flipped from full→truncated on every step, breaking Anthropic's exact-byte
  prompt-cache prefix and forcing a full cache rewrite continuously. A
  12-step run was measured costing **$1.50+** from this before the batching fix
  — input tokens climbed 28K→63K instead of flattening once cached. This is a
  cost-of-caching concern, not just a token-budget one.
- **`save_memory` brain-memory escape hatch**: the model can call `save_memory`
  (defined in `agentToolSet.ts`) to push short facts into a `brainMemory[]`
  array. Those get re-injected verbatim as a user-role note right before the
  recent-steps window on every subsequent step — surviving compaction that
  would otherwise erase the reasoning behind an earlier decision. The system
  prompt explicitly instructs the model to use this "early and often" for
  architecture decisions, files touched, and user requirements.

## 5. Tool surface (`server/src/agent-tools/`, wired via `agentToolSet.ts`)

26 tools, broader than a typical retrieval-only coding agent because this one
also provisions infrastructure, not just edits code:

**File ops**: `write_file`, `edit_file`, `read_file`, `read_files`, `list_files`,
`delete_file`, `rename_file`

**Search/retrieval**: `grep`, `glob_files`, `search_codebase`,
`find_symbol_usages`, `search_org_knowledge`

**Build/diagnostics**: `get_build_errors`, `run_command`

**Database**: `provision_database`, `query_database`, `get_database_schema`
(see `docs/database.md`)

**Secrets**: `set_secret`, `list_secrets` (see `docs/settings.md`)

**Edge functions**: `write_edge_function`, `delete_edge_function` (see
`docs/edge-functions.md`)

**Deploy/publish**: `publish_site`, `push_to_github`

**Assets**: `place_asset`

**Reasoning**: `think` (explicit scratchpad), `save_memory` (brain memory, §4)

## 6. Edit application: exact match first, fuzzy fallback

`edit_file.ts` uses the same `old_str`/`new_str` convention several independent
coding-agent projects converged on. `fuzzyFind()` normalizes whitespace (trims
trailing whitespace per line, collapses blank lines) and retries the match if
the exact string isn't found — no separate "apply model," just this one
fallback tier.

## 7. In-loop syntax checking

`checkTsSyntaxInLoop()` (in `agentContextCompaction.ts`) runs a fast,
syntax-only TypeScript/JSX parse (`ts.transpileModule`, not a full type-checked
project build) on `.tsx`/`.jsx` files under `src/` immediately after a write —
catching unclosed brackets, malformed JSX, and stray tokens in milliseconds,
before they'd otherwise only surface in a slower, cold post-run repair pass.

## 8. Step-budget-exhaustion handling

Near the end of the step budget (`LOW_STEPS_THRESHOLD`, `MAX_STEPS - 5`), a
warning gets injected into the prompt forcing the model to prioritize finishing
`src/App.tsx` over writing more utility files — a partial build with a missing
`App.tsx` is the single worst outcome (broken preview), so the loop actively
steers away from it as the budget runs out.

If the run genuinely exhausts its step budget without finishing
(`stepCount >= MAX_STEPS - 1`), the user gets an honest message: *"I stopped
without finishing this change (after N steps of MAX) — the assigned model gave
up early rather than running out of budget. Nothing was changed."*

## What this doc does NOT cover

- The model-provider fallback chain (Anthropic primary, Gemini/DeepSeek
  fallback) — `llm-control.service.ts` / `llm-health.service.ts`, see
  `docs/server.md`.
- Database/edge-function/secrets tool internals — see `docs/database.md`,
  `docs/edge-functions.md`, `docs/settings.md`.
- Preview/sandbox execution (Docker-based, `runtime_mode: 'single-host-docker'`
  per `runtime.service.ts`) — see `docs/architecture.md`.
