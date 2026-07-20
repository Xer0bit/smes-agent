# Agent Edit Reliability   Design Spec
**Date:** 2026-04-24  
**Status:** Approved  
**Author:** Xer0bit + Claude  

---

## Problem Summary

After 5 days of investigation, three failure cases were identified when users ask the agent to change existing code (as opposed to a fresh build):

- **Case B   Silent failure:** Agent says "done" but nothing changed on disk. Tool errors (SEARCH mismatch, bracket rejection, read-before-write block) are swallowed after context compaction.
- **Case C   Wrong changes:** Agent does not follow the instruction correctly. It edits the wrong thing or reverts a previous change. Caused by compaction destroying write memory and history stripping removing all file-state information.
- **Case D   Regressions:** Agent changes the right thing but breaks other files that depend on it. No cross-file impact awareness at edit time.

---

## Root Causes (confirmed by code audit)

### R1   Context compaction destroys write memory (Cases B, C)
`KEEP_RECENT_STEPS = 2`, `COMPACT_AFTER_STEP = 3`. After step 5, `write_file` tool call args are truncated to **150 chars** (~4 lines). The agent has no memory of what it wrote. Read results are truncated to 200 chars. This causes wrong SEARCH blocks, import mismatches, and reverted changes.

### R2   History stripping removes file-state information (Case C)
The frontend strips `<ecomgear-write>` content from assistant history before sending to the next request. The agent receives only `"I've built the homepage"` with zero information about which files were modified or what they contain. It cannot know what the project state is from history alone.

### R3   edit_file fuzzy match has a char-counting line-mapping bug (Cases B, D)
The third fuzzy match tier (indentation-agnostic) uses `charCount === idx` to find the start line, which misses when `idx` falls mid-line. This maps the match to the wrong line, replacing the wrong block in the file   producing valid-looking but semantically broken code.

### R4   No cross-file impact awareness (Case D)
The import/reverse-graph is built at run start but never shown to the agent or used at write time. The agent edits `Navbar.tsx` without knowing `Home.tsx`, `About.tsx`, and `App.tsx` all import from it.

### R5   File context peek too small for edit tasks (Cases B, C)
`MAX_MENTIONED_FILE_CONTEXT_CHARS = 4000`, `MAX_FILE_CONTEXT_CHARS = 1200`. For a 300-line component, only 35 lines are shown. The agent forms an incorrect mental model and produces wrong SEARCH blocks.

### R6   No automatic cross-step state journal (Cases B, C, D)
`save_memory` requires the agent to proactively remember facts. It doesn't. The only automatic persistence across steps is the compacted (and truncated) message history.

---

## Solution: Approach B   Per-Run Change Journal + Bug Fixes

### Scope
Primarily server-side. No database changes. One minimal frontend change: `AgentChatPanel.tsx` gains a `filesModified` field on the Message type and appends it to outgoing history. All agent logic, tool fixes, and the new ledger are server-only.

### Files changed
```
server/src/services/
  runStateLedger.ts          ← NEW
  agentLoopService.ts        ← modify (compaction, context, prepareStep, ledger wiring)

server/src/agent-tools/
  edit_file.ts               ← modify (fuzzy match fix + ledger + dependency warning)
  write_file.ts              ← modify (ledger registration + dependency warning)
  types.ts                   ← modify (add ledger + reverseGraph to AgentContext)

src/components/chat/
  AgentChatPanel.tsx         ← modify (extract filesModified from tool XML, append to history)
```

---

## Module Designs

### 1. RunStateLedger (`server/src/services/runStateLedger.ts`)

A plain TypeScript class, one instance per agent run, passed through `AgentContext`.

```typescript
interface LedgerEntry {
  step: number;
  operation: 'read' | 'write' | 'edit' | 'edit-failed';
  path: string;
  detail: string;  // "243 lines", "exports: HomePage (default)", "SEARCH: 'const btn = ...'"
}

class RunStateLedger {
  private entries: LedgerEntry[] = [];
  private currentStep = 0;

  setStep(n: number): void;
  recordRead(path: string, lineCount: number): void;
  recordWrite(path: string, lineCount: number, exports: string): void;
  recordEdit(path: string, searchSnippet: string): void;
  recordEditFailed(path: string, searchSnippet: string, reason: string): void;

  /** Returns a compact journal block for injection into prepareStep */
  buildJournalBlock(): string;

  /** Returns a compact manifest of all written/edited paths (for history augmentation) */
  getWrittenPaths(): string[];
}
```

**Journal block format** (injected as user message in `prepareStep`):
```
[Run Change Journal   step 7 of 25]
✅ read    src/components/Navbar.tsx (243 lines)
✅ write   src/pages/Home.tsx (187 lines)   exports: HomePage
✅ edit    src/components/Navbar.tsx   target: "const buttonClass = ..."
❌ edit-failed src/App.tsx   SEARCH not matched: "import { Home } from..."
              → You MUST call read_file("src/App.tsx") and retry with exact content.
```

The journal block is injected at every step (not just after compaction begins). It is a separate user message inserted immediately before the most recent step's messages so it doesn't interfere with the message pair structure that the AI SDK expects.

**Injection point:** `prepareStep` hook in `streamText`. After compacting older steps, insert the journal block as a user message at position `stepStartIdx + compactUpTo * 2`.

### 2. History Augmentation (`AgentChatPanel.tsx`)

**Goal:** Each assistant message in history must carry a compact list of files it modified so the next agent run knows which files to re-read.

**Implementation:**
- When a run completes (`onDone`), collect the paths from `toolXmlAccum` (already accumulated: all `<ecomgear-write path="...">` and `<ecomgear-edit path="...">` tags).
- Store as `m.filesModified: string[]` on the completed assistant message.
- When building `history` for the next `streamAgentGeneration` call, append to each assistant message's content:
  ```
  [Files modified in this response: src/components/Navbar.tsx, src/App.tsx]
  ```
- This is appended AFTER the human-readable content and BEFORE sending   never stored in the DB or shown in the UI.

**Message type change:** Add `filesModified?: string[]` to the `Message` interface in `AgentChatPanel.tsx`.

### 3. edit_file Fuzzy Match Fix (`server/src/agent-tools/edit_file.ts`)

Replace the char-counting startLine calculation with a pre-built offset table + binary search in both the whitespace-normalized and indentation-agnostic match tiers.

```typescript
function buildOffsetTable(lines: string[]): number[] {
  const offsets = [0];
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offsets[i] + lines[i].length + 1); // +1 for \n
  }
  return offsets;
}

function findStartLine(offsets: number[], idx: number): number {
  let lo = 0, hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
```

This replaces the current loop in both `normalizeWs` and `stripIndent` match paths. No behaviour change for exact matches (tier 1 is unaffected).

Additionally: when all three tiers fail, return the **first 5 lines that partially match** the first line of the needle as a hint to the agent (currently returns only the first 100 lines of the file as a dump with no guidance).

### 4. Dependency Impact Warning (edit_file.ts + write_file.ts)

`AgentContext` gains two new fields:
```typescript
reverseGraph: Map<string, Set<string>>;  // importers of each file
```

Populated at run start (the graph is already built   just needs to be passed through).

In `edit_file.execute` and `write_file.execute`, after a successful write, check `ctx.reverseGraph.get(args.path)`. If non-empty, prepend a warning to the return value:

```
⚠️  DEPENDENCY ALERT: 3 files import from src/components/Navbar.tsx:
   • src/pages/Home.tsx
   • src/pages/About.tsx
   • src/App.tsx
   If you changed exports or props, those files may need updating too.

Successfully edited src/components/Navbar.tsx
```

For `edit_file` only (not `write_file` for new files), because new files have no existing importers by definition.

### 5. Compaction Constants Fix (`agentLoopService.ts`)

| Constant | Old | New | Reason |
|---|---|---|---|
| `KEEP_RECENT_STEPS` | 2 | 4 | Keep 4 full steps before compacting |
| `COMPACT_AFTER_STEP` | 3 | 5 | Start compaction later |
| write_file content truncation | 150 chars | emit `[Wrote: path (N lines)]` | Never truncate to meaningless fragment |
| edit_file diff truncation | 200 chars | emit `[Edited: path   target: "snippet"]` | Preserve intent |
| read_file result truncation | 200 chars | emit `[Read: path (N lines)]` | Ledger has real state |
| think truncation | 400 chars | 600 chars | More reasoning preserved |

**Compacted form for write_file** (replaces truncated content in compactToolCallArgs):
```
[compacted] write_file: src/components/Navbar.tsx (187 lines)   see Change Journal
```

### 6. Context Limit Increases (`agentLoopService.ts`)

| Parameter | Old | New |
|---|---|---|
| `MAX_CONTEXT_FILES` | 5 | 8 |
| `MAX_FILE_CONTEXT_CHARS` (non-mentioned) | 1200 | 2500 |
| `MAX_MENTIONED_FILE_CONTEXT_CHARS` | 4000 | 8000 |
| `MAX_CONTEXT_CHARS` (total) | 16000 | 28000 |

**Reverse-graph scoring:** Files that import FROM a directly-mentioned file (i.e., `reverseGraph.get(mentioned)`) receive score **70** in context selection (same tier as `relatedByImport`). Previously they had score 0 or 30. This ensures that when you edit `Navbar.tsx`, its importers appear in context automatically.

---

## Data Flow (Edit Request)

```
User: "change the hero button color to red"
  │
  ▼
AgentChatPanel builds history:
  assistant msg 3: "Done building the homepage. [Files modified: src/pages/Home.tsx, src/components/Navbar.tsx]"
  │
  ▼
agentLoopService._runAgentLoopInner:
  1. Build import + reverse graph from disk snapshot
  2. Score context: Home.tsx (score 100, mentioned), Navbar.tsx (score 70, importer of Home)
  3. Show 8000-char preview of Home.tsx + 2500-char preview of Navbar.tsx + App.tsx
  4. Start streamText with RunStateLedger
  │
  ▼
Agent step 1 (think): plans edits, reads Home.tsx
  Ledger: [read: Home.tsx, 187 lines]
  │
  ▼
Agent step 2 (read_file: src/pages/Home.tsx):
  readFiles.add("src/pages/Home.tsx")
  Ledger: [read: Home.tsx, 187 lines]
  │
  ▼
Agent step 3 (edit_file: src/pages/Home.tsx):
  fuzzyFind with binary-search line mapping → correct match
  Dependency warning: "2 files import from Home.tsx: App.tsx, index route"
  Ledger: [edit: Home.tsx   target: "className=\"btn-blue\""]
  │
  ▼
prepareStep (step 4):
  Inject journal block:
    ✅ read  src/pages/Home.tsx (187 lines)
    ✅ edit  src/pages/Home.tsx   target: "className=\"btn-blue\""
  Agent sees this → knows what it already did → proceeds correctly
```

---

## What This Does NOT Change

- No database schema changes
- No new API endpoints
- No changes to the preview service
- No changes to snapshot/rollback logic
- No changes to the system prompt (the journal block is injected as a conversation message, not into the system prompt)
- No changes to error handling, retry logic, or model fallback

---

## Success Criteria

After implementation, the following should hold:

1. **Case B eliminated:** When `edit_file` fails (SEARCH mismatch, bracket rejection), the failure appears explicitly in the Change Journal at the next step. The agent sees `❌ edit-failed` and is instructed to `read_file` and retry. It cannot "forget" the failure.

2. **Case C reduced significantly:** The agent can see in history which files were modified in previous turns (`[Files modified: ...]`). Combined with the Change Journal, it always knows the current state of files it has touched in this run.

3. **Case D reduced:** When the agent edits a file, it immediately sees which files import from it. It is prompted to check those files. Importers are automatically included in the context peek.

4. **edit_file fuzzy match:** The indentation-agnostic match tier correctly maps normalized character offsets to original lines using binary search. No off-by-one line mapping.

5. **No regressions in build mode:** All changes are additive or behind constants. The fresh-build path is unaffected.

---

## Out of Scope (Approach C   future)

- Cross-session persistent memory (Supabase)
- Full file state cache per run (storing complete content after every write)
- Semantic grep-based dependency search
- Dependency graph diagram shown in system prompt
