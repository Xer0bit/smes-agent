# Agent Edit Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Cases B/C/D — agent silent failures, wrong edits, and regressions — by adding a per-run change journal, fixing the edit_file fuzzy match bug, adding dependency impact warnings, augmenting history with modified-file footers, and tuning compaction/context constants.

**Architecture:** A new `RunStateLedger` class (one instance per agent run) records every read/write/edit and emits a compact journal block injected into each step's context via `prepareStep`. The `reverseGraph` (already built) is threaded into tool context to emit dependency warnings. `AgentChatPanel` appends a file-manifest footer to outgoing history messages.

**Tech Stack:** TypeScript, Vercel AI SDK (`streamText`, `prepareStep`), Node.js fs, React (frontend only for Task 6).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `server/src/services/runStateLedger.ts` | **CREATE** | Per-run journal: record reads/writes/edits, emit journal block |
| `server/src/agent-tools/types.ts` | **MODIFY** | Add `ledger` and `reverseGraph` fields to `AgentContext` |
| `server/src/agent-tools/edit_file.ts` | **MODIFY** | Fix fuzzy-match line mapping bug; call ledger; emit dependency warning |
| `server/src/agent-tools/write_file.ts` | **MODIFY** | Call ledger on success; emit dependency warning for importers |
| `server/src/services/agentLoopService.ts` | **MODIFY** | Wire ledger + reverseGraph into ctx; inject journal in prepareStep; fix compaction summaries; increase constants |
| `src/components/chat/AgentChatPanel.tsx` | **MODIFY** | Add `filesModified` to Message type; append footer to history |

---

## Task 1: Create RunStateLedger

**Files:**
- Create: `server/src/services/runStateLedger.ts`

- [ ] **Step 1: Write the file**

```typescript
// server/src/services/runStateLedger.ts

export type LedgerOperationType = 'read' | 'write' | 'edit' | 'edit-failed';

interface LedgerEntry {
  step: number;
  operation: LedgerOperationType;
  path: string;
  detail: string;
}

export class RunStateLedger {
  private entries: LedgerEntry[] = [];
  private currentStep = 0;

  setStep(n: number): void {
    this.currentStep = n;
  }

  recordRead(path: string, lineCount: number): void {
    this.entries.push({ step: this.currentStep, operation: 'read', path, detail: `${lineCount} lines` });
  }

  recordWrite(path: string, lineCount: number, topExports: string): void {
    const detail = topExports
      ? `${lineCount} lines — exports: ${topExports}`
      : `${lineCount} lines`;
    this.entries.push({ step: this.currentStep, operation: 'write', path, detail });
  }

  recordEdit(path: string, searchSnippet: string): void {
    const snippet = searchSnippet.slice(0, 60).replace(/\n/g, '↵');
    this.entries.push({ step: this.currentStep, operation: 'edit', path, detail: `target: "${snippet}"` });
  }

  recordEditFailed(path: string, searchSnippet: string, reason: string): void {
    const snippet = searchSnippet.slice(0, 60).replace(/\n/g, '↵');
    this.entries.push({
      step: this.currentStep,
      operation: 'edit-failed',
      path,
      detail: `SEARCH not matched: "${snippet}" — ${reason.slice(0, 120)}`,
    });
  }

  buildJournalBlock(): string {
    if (this.entries.length === 0) return '';
    const icon = (op: LedgerOperationType) => op === 'edit-failed' ? '❌' : '✅';
    const lines = this.entries.map(e => {
      const base = `${icon(e.operation)} ${e.operation.padEnd(11)} ${e.path}`;
      if (e.operation === 'edit-failed') {
        return `${base}\n              → ${e.detail}\n              → You MUST call read_file("${e.path}") and retry with exact content.`;
      }
      return e.detail ? `${base} — ${e.detail}` : base;
    });
    return (
      `[Run Change Journal — step ${this.currentStep} of 25]\n` +
      `This is an authoritative log of every file you touched this run.\n` +
      lines.join('\n')
    );
  }

  /** Paths of all files written or edited this run (deduplicated, preserving order). */
  getWrittenPaths(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const e of this.entries) {
      if ((e.operation === 'write' || e.operation === 'edit') && !seen.has(e.path)) {
        seen.add(e.path);
        result.push(e.path);
      }
    }
    return result;
  }
}
```

- [ ] **Step 2: Verify it compiles (no separate test — it's a pure data class)**

```bash
cd /home/xer0bit/Desktop/ecomgear-main/server && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors related to `runStateLedger.ts` (other pre-existing errors are OK).

- [ ] **Step 3: Commit**

```bash
git add server/src/services/runStateLedger.ts
git commit -m "feat(ledger): add RunStateLedger for per-run change journal"
```

---

## Task 2: Extend AgentContext with ledger + reverseGraph

**Files:**
- Modify: `server/src/agent-tools/types.ts`

- [ ] **Step 1: Add imports and new fields**

Add after the existing import block and inside `AgentContext`:

```typescript
// Add at top of file (after existing imports):
import type { RunStateLedger } from '../services/runStateLedger.js';

// Add inside AgentContext interface (after readFiles):
  /** Per-run change journal — records every read/write/edit for journal injection. */
  ledger?: RunStateLedger;
  /**
   * Reverse import graph: for each file path, the set of files that import it.
   * Used by write_file / edit_file to warn the agent about downstream breakage.
   */
  reverseGraph?: Map<string, Set<string>>;
```

- [ ] **Step 2: Verify compilation**

```bash
cd /home/xer0bit/Desktop/ecomgear-main/server && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/agent-tools/types.ts
git commit -m "feat(agent-tools): extend AgentContext with ledger and reverseGraph"
```

---

## Task 3: Fix edit_file fuzzy match + add ledger + dependency warning

**Files:**
- Modify: `server/src/agent-tools/edit_file.ts`

Changes:
1. Replace char-counting startLine with binary-search offset table in both fuzzy tiers
2. Call `ctx.ledger?.recordEdit` on success and `ctx.ledger?.recordEditFailed` on failure
3. Prepend dependency warning from `ctx.reverseGraph` after a successful edit

- [ ] **Step 1: Add helper functions** (insert after the existing `normalizeWs` function, before `fuzzyFind`)

```typescript
/** Build cumulative character-offset table for line-start positions. */
function buildOffsets(lines: string[]): number[] {
  const offsets = [0];
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offsets[i] + lines[i].length + 1); // +1 for \n
  }
  return offsets;
}

/**
 * Binary search: return the largest line index whose offset <= idx.
 * Replaces the buggy char-counting loop that missed when idx fell mid-line.
 */
function offsetToLine(offsets: number[], idx: number): number {
  let lo = 0;
  let hi = offsets.length - 2; // last valid line index
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
```

- [ ] **Step 2: Replace the normalizeWs match tier's startLine logic** inside `fuzzyFind`

Replace this block:
```typescript
  // Map normalized index back to original string
  const hayLines = haystack.split('\n');
  const normLines = normHay.split('\n');
  const needleLineCount = normNeedle.split('\n').length;

  // Find which original line corresponds to the normalized index
  let charCount = 0;
  let startLine = 0;
  for (let i = 0; i < normLines.length; i++) {
    if (charCount === idx) { startLine = i; break; }
    if (charCount > idx) { startLine = Math.max(0, i - 1); break; }
    charCount += normLines[i].length + 1; // +1 for \n
  }
  const endLine = startLine + needleLineCount;
  const originalSlice = hayLines.slice(startLine, endLine).join('\n');
  return { found: true, original: originalSlice };
```

With:
```typescript
  // Map normalized index back to original string using binary-search offset table
  const hayLines = haystack.split('\n');
  const normLines = normHay.split('\n');
  const needleLineCount = normNeedle.split('\n').length;
  const normOffsets = buildOffsets(normLines);
  const startLine = offsetToLine(normOffsets, idx);
  const endLine = Math.min(hayLines.length, startLine + needleLineCount);
  const originalSlice = hayLines.slice(startLine, endLine).join('\n');
  return { found: true, original: originalSlice };
```

- [ ] **Step 3: Replace the stripIndent match tier's startLine logic** inside `fuzzyFind`

Replace this block:
```typescript
    const hayLines = haystack.split('\n');
    const stripLines = stripHay.split('\n');
    const needleLineCount = stripNeedle.split('\n').length;
    let charCount = 0;
    let startLine = 0;
    for (let i = 0; i < stripLines.length; i++) {
      if (charCount === idxStrip) { startLine = i; break; }
      if (charCount > idxStrip) { startLine = Math.max(0, i - 1); break; }
      charCount += stripLines[i].length + 1;
    }
    const endLine = startLine + needleLineCount;
    const originalSlice = hayLines.slice(startLine, endLine).join('\n');
    return { found: true, original: originalSlice };
```

With:
```typescript
    const hayLines = haystack.split('\n');
    const stripLines = stripHay.split('\n');
    const needleLineCount = stripNeedle.split('\n').length;
    const stripOffsets = buildOffsets(stripLines);
    const startLine = offsetToLine(stripOffsets, idxStrip);
    const endLine = Math.min(hayLines.length, startLine + needleLineCount);
    const originalSlice = hayLines.slice(startLine, endLine).join('\n');
    return { found: true, original: originalSlice };
```

- [ ] **Step 4: Add ledger calls and dependency warning in `execute`**

After the `applySearchReplace` call that returns `{ success: false }`, add inside the error return (after the `previewLines` block, before the final `return`):

```typescript
      // Record the failed edit in the ledger so the journal shows ❌
      const firstSearchLine = args.diff.match(/<<<<<<< SEARCH\n([\s\S]*?)\n=======/)?.[1] ?? '';
      ctx.ledger?.recordEditFailed(args.path, firstSearchLine, result.error ?? 'unknown');
```

After the TypeScript syntax check passes and before `fs.writeFileSync`, add ledger record + dependency warning:

```typescript
    // Record in ledger before writing
    const firstSearchLine = args.diff.match(/<<<<<<< SEARCH\n([\s\S]*?)\n=======/)?.[1] ?? '';
    ctx.ledger?.recordEdit(args.path, firstSearchLine);

    // Build dependency warning (importers of this file)
    const importers = ctx.reverseGraph?.get(args.path);
    const depWarning = importers && importers.size > 0
      ? `⚠️  DEPENDENCY ALERT: ${importers.size} file(s) import from ${args.path}:\n` +
        Array.from(importers).map(p => `   • ${p}`).join('\n') +
        `\nIf you changed exports or props, update those files too.\n\n`
      : '';
```

Then change the success return at the bottom to:
```typescript
    const fixNote = fixes.length > 0 ? `\nAuto-fixed: ${fixes.join('; ')}` : '';
    return `${depWarning}Successfully edited ${args.path}${fixNote}`;
```

- [ ] **Step 5: Verify compilation**

```bash
cd /home/xer0bit/Desktop/ecomgear-main/server && npx tsc --noEmit 2>&1 | head -40
```

Expected: no new errors from `edit_file.ts`.

- [ ] **Step 6: Commit**

```bash
git add server/src/agent-tools/edit_file.ts
git commit -m "fix(edit_file): binary-search line mapping, ledger recording, dependency warning"
```

---

## Task 4: Update write_file to call ledger + dependency warning

**Files:**
- Modify: `server/src/agent-tools/write_file.ts`

- [ ] **Step 1: Extract top-level exports helper** (add before `execute`)

Add this helper function inside the file (after the schema, before the `writeFileTool` export):

```typescript
/** Extract the first default or named export identifier from source for ledger labelling. */
function extractTopExports(content: string): string {
  const defaultMatch = content.match(/export\s+default\s+(?:function\s+|class\s+)?(\w+)/);
  if (defaultMatch) return `${defaultMatch[1]} (default)`;
  const namedMatches = [...content.matchAll(/export\s+(?:function|class|const|let|var)\s+(\w+)/g)].map(m => m[1]);
  return namedMatches.slice(0, 3).join(', ');
}
```

- [ ] **Step 2: Add ledger call after successful write**

After `fs.writeFileSync(fullPath, content, 'utf8');`, add:

```typescript
    // Record in ledger
    const lineCount = content.split('\n').length;
    const topExports = /\.(tsx?|jsx?)$/.test(args.path) ? extractTopExports(content) : '';
    ctx.ledger?.recordWrite(args.path, lineCount, topExports);
```

- [ ] **Step 3: Add dependency warning for existing importers**

After the ledger call, add (only matters when overwriting an existing file):

```typescript
    // Warn agent about files that import from this one (regressions risk)
    const importers = ctx.reverseGraph?.get(args.path);
    const depWarning = importers && importers.size > 0
      ? `⚠️  DEPENDENCY ALERT: ${importers.size} file(s) import from ${args.path}:\n` +
        Array.from(importers).map(p => `   • ${p}`).join('\n') +
        `\nVerify those files still compile after your changes.\n\n`
      : '';
```

Then update the final return statements to prepend `depWarning`:

```typescript
    if (importWarnings.length > 0) {
      const warnNote = `\n\n⚠️  ACTION REQUIRED — MISSING DEPENDENCIES:\n` +
        importWarnings.map(p => `  • ${p}  ← does not exist on disk`).join('\n') +
        `\n\nYou MUST write these files NEXT before calling get_build_errors. ` +
        `If you do not, the build will fail with "Cannot find module" errors.`;
      return `${depWarning}Wrote ${args.path}${fixNote}${warnNote}`;
    }

    return `${depWarning}Successfully wrote ${args.path}${fixNote}`;
```

- [ ] **Step 4: Verify compilation**

```bash
cd /home/xer0bit/Desktop/ecomgear-main/server && npx tsc --noEmit 2>&1 | head -40
```

- [ ] **Step 5: Commit**

```bash
git add server/src/agent-tools/write_file.ts
git commit -m "feat(write_file): add ledger recording and dependency warning on overwrite"
```

---

## Task 5: Wire everything into agentLoopService — the big one

**Files:**
- Modify: `server/src/services/agentLoopService.ts`

Six sub-changes: (a) import ledger, (b) tune constants, (c) increase context limits, (d) wire reverseGraph into ctx, (e) fix compaction summaries, (f) inject journal in prepareStep.

- [ ] **Step 5a: Add import at top of file**

After the existing tool imports (after `import { thinkTool }...`), add:

```typescript
import { RunStateLedger } from './runStateLedger.js';
```

- [ ] **Step 5b: Tune compaction and step constants**

Change:
```typescript
const KEEP_RECENT_STEPS = 2;
const COMPACT_AFTER_STEP = 3;
```
To:
```typescript
const KEEP_RECENT_STEPS = 4;
const COMPACT_AFTER_STEP = 5;
```

- [ ] **Step 5c: Increase context limits**

Change:
```typescript
  const MAX_CONTEXT_CHARS = parseInt(process.env.AI_MAX_CONTEXT_CHARS || '16000', 10);
  const MAX_CONTEXT_FILES = parseInt(process.env.AI_MAX_CONTEXT_FILES || '5', 10);
  const MAX_FILE_CONTEXT_CHARS = parseInt(process.env.AI_MAX_FILE_CONTEXT_CHARS || '1200', 10);
  const MAX_MENTIONED_FILE_CONTEXT_CHARS = parseInt(process.env.AI_MAX_MENTIONED_FILE_CONTEXT_CHARS || '4000', 10);
```
To:
```typescript
  const MAX_CONTEXT_CHARS = parseInt(process.env.AI_MAX_CONTEXT_CHARS || '28000', 10);
  const MAX_CONTEXT_FILES = parseInt(process.env.AI_MAX_CONTEXT_FILES || '8', 10);
  const MAX_FILE_CONTEXT_CHARS = parseInt(process.env.AI_MAX_FILE_CONTEXT_CHARS || '2500', 10);
  const MAX_MENTIONED_FILE_CONTEXT_CHARS = parseInt(process.env.AI_MAX_MENTIONED_FILE_CONTEXT_CHARS || '8000', 10);
```

- [ ] **Step 5d: Include reverse-graph importers in context scoring**

In the `sortedFiles` sort comparator, add score 70 for reverse-graph files. Find this block:

```typescript
  const sortedFiles = fileSources.slice().sort((a, b) => {
    const aScore = directlyMentioned.has(a.path) ? 100
      : relatedByImport.has(a.path) ? 80
      : criticalFiles.has(a.path) ? 60
      : a.path.startsWith('src/pages/') ? 40
      : a.path.startsWith('src/components/') && !a.path.includes('/ui/') ? 30
      : 0;
    const bScore = directlyMentioned.has(b.path) ? 100
      : relatedByImport.has(b.path) ? 80
      : criticalFiles.has(b.path) ? 60
      : b.path.startsWith('src/pages/') ? 40
      : b.path.startsWith('src/components/') && !b.path.includes('/ui/') ? 30
      : 0;
```

Replace with:
```typescript
  // Importers of mentioned files: editing Navbar.tsx → Home.tsx/About.tsx should be in context
  const importersOfMentioned = new Set<string>();
  for (const mentionedPath of directlyMentioned) {
    for (const importer of reverseGraph.get(mentionedPath) ?? []) {
      importersOfMentioned.add(importer);
    }
  }

  const sortedFiles = fileSources.slice().sort((a, b) => {
    const aScore = directlyMentioned.has(a.path) ? 100
      : relatedByImport.has(a.path) ? 80
      : importersOfMentioned.has(a.path) ? 70
      : criticalFiles.has(a.path) ? 60
      : a.path.startsWith('src/pages/') ? 40
      : a.path.startsWith('src/components/') && !a.path.includes('/ui/') ? 30
      : 0;
    const bScore = directlyMentioned.has(b.path) ? 100
      : relatedByImport.has(b.path) ? 80
      : importersOfMentioned.has(b.path) ? 70
      : criticalFiles.has(b.path) ? 60
      : b.path.startsWith('src/pages/') ? 40
      : b.path.startsWith('src/components/') && !b.path.includes('/ui/') ? 30
      : 0;
```

- [ ] **Step 5e: Wire ledger + reverseGraph into AgentContext**

Find where `const ctx: AgentContext = {` is built (around line 1018). Add after `readFiles: new Set<string>(),`:

```typescript
    ledger,
    reverseGraph,
```

And before that block, declare them:

```typescript
  const ledger = new RunStateLedger();
  // reverseGraph is already built above — pass it into context
```

Also find the declaration `const brainMemory: string[] = [];` (around line 1452) and add immediately before it:

```typescript
  // reverseGraph reference for tool context (already built above in file scoring section)
  // ledger is created here so it's available to tools and the prepareStep hook
  const ledger = new RunStateLedger();
```

Wait — the order matters. `reverseGraph` and `ledger` need to exist before `ctx`. Let me be precise:

The `reverseGraph` is built at line ~1072. The `ctx` is built at ~1018. In the actual file, `ctx` comes AFTER the reverseGraph build. So we just need to declare `ledger` before `ctx` and then pass both into ctx.

Find the line `const brainMemory: string[] = [];` and add directly before it:
```typescript
  const ledger = new RunStateLedger();
```

Then in the `ctx` object literal, add after `readFiles: new Set<string>(),`:
```typescript
    ledger,
    reverseGraph,
```

- [ ] **Step 5f: Fix compaction summaries for write_file and edit_file**

In `compactToolCallArgs`, replace the write_file and edit_file truncation blocks:

```typescript
    case 'write_file':
      if (typeof args.content === 'string' && args.content.length > 200) {
        args.content = truncStr(args.content, 150);
      }
      break;
    case 'edit_file':
      if (typeof args.diff === 'string' && args.diff.length > 300) {
        args.diff = truncStr(args.diff, 200);
      }
      break;
    case 'think':
      if (typeof args.thought === 'string' && args.thought.length > 500) {
        args.thought = truncStr(args.thought, 400);
      }
      break;
```

With:
```typescript
    case 'write_file':
      if (typeof args.content === 'string' && args.content.length > 200) {
        const lines = args.content.split('\n').length;
        args.content = `[compacted] ${lines} lines written — see Change Journal for details`;
      }
      break;
    case 'edit_file':
      if (typeof args.diff === 'string' && args.diff.length > 300) {
        const searchSnippet = args.diff.match(/<<<<<<< SEARCH\n([\s\S]{0,60})/)?.[1]?.replace(/\n/g, '↵') ?? '';
        args.diff = `[compacted] edit to ${args.path ?? 'file'} — target: "${searchSnippet}" — see Change Journal`;
      }
      break;
    case 'think':
      if (typeof args.thought === 'string' && args.thought.length > 500) {
        args.thought = truncStr(args.thought, 600);
      }
      break;
```

Also fix `compactToolResult` for read_file:

```typescript
    case 'read_file':
      if (result.length > 300) part.result = truncStr(result, 200);
      break;
```

Change to:
```typescript
    case 'read_file':
      if (result.length > 300) {
        const lines = result.split('\n').length;
        part.result = `[compacted] ${lines}-line file content — agent read this in full at step time. Call read_file again if you need current content.`;
      }
      break;
```

- [ ] **Step 5g: Inject journal block in prepareStep**

Find the `prepareStep` hook inside `attemptStream`:

```typescript
        prepareStep: async ({ stepNumber, messages }) => {
          const compacted = compactStepMessages(messages, stepNumber, brainMemory);
          if (compacted !== messages) {
            return { messages: compacted };
          }
          return {};
        },
```

Replace with:
```typescript
        prepareStep: async ({ stepNumber, messages }) => {
          ledger.setStep(stepNumber);
          const compacted = compactStepMessages(messages, stepNumber, brainMemory);
          const journalBlock = ledger.buildJournalBlock();
          if (journalBlock) {
            // Inject journal as a user message immediately before the assistant turn
            // so the agent has an authoritative record of what it has done this run.
            const base = compacted !== messages ? compacted : [...messages];
            // Find where step messages begin (first assistant message)
            let insertIdx = base.length;
            for (let i = 0; i < base.length; i++) {
              if (base[i].role === 'assistant' && Array.isArray(base[i].content)) {
                insertIdx = i;
                break;
              }
            }
            // Insert after any compacted steps — right before the most recent step
            const recentStepStart = Math.max(insertIdx, base.length - KEEP_RECENT_STEPS * 2);
            const withJournal = [
              ...base.slice(0, recentStepStart),
              { role: 'user' as const, content: journalBlock },
              ...base.slice(recentStepStart),
            ];
            return { messages: withJournal };
          }
          if (compacted !== messages) {
            return { messages: compacted };
          }
          return {};
        },
```

Also update `onStepFinish` to keep ledger step in sync:

```typescript
        onStepFinish: ({ text, toolCalls, toolResults }) => {
          stepCount++;
          ledger.setStep(stepCount);  // ← add this line
```

- [ ] **Step 5h: Verify compilation**

```bash
cd /home/xer0bit/Desktop/ecomgear-main/server && npx tsc --noEmit 2>&1 | head -50
```

Expected: no new errors.

- [ ] **Step 5i: Commit**

```bash
git add server/src/services/agentLoopService.ts
git commit -m "feat(agent-loop): wire RunStateLedger, increase context limits, fix compaction summaries, inject journal in prepareStep"
```

---

## Task 6: History augmentation in AgentChatPanel

**Files:**
- Modify: `src/components/chat/AgentChatPanel.tsx`

Goal: When building the `history` array for the next `streamAgentGeneration` call, append `[Files modified in this response: ...]` to each assistant message that has `filesModified`.

- [ ] **Step 1: Add `filesModified` to the `Message` interface**

Find the `Message` interface definition in `AgentChatPanel.tsx`:

```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'pending' | 'streaming' | 'complete' | 'error';
  summary?: string;
  toolActivities?: ToolActivity[];
  attachments?: PendingAttachment[];
}
```

Add `filesModified` field:

```typescript
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'pending' | 'streaming' | 'complete' | 'error';
  summary?: string;
  toolActivities?: ToolActivity[];
  attachments?: PendingAttachment[];
  /** Paths of files written/edited in this assistant turn — appended to outgoing history. */
  filesModified?: string[];
}
```

- [ ] **Step 2: Extract filesModified from toolXmlAccum on done**

In `handleSubmit`, inside the `onDone` callback where the final message is set, extract written paths from `toolXmlAccum` and store them on the message. Find the `setMessages` call inside `onDone` that sets the final assistant message and update it:

```typescript
            // Extract all paths written/edited in this run from accumulated XML
            const modifiedPaths: string[] = [];
            const writeRe = /<ecomgear-(?:write|edit)\s+path="([^"]+)"/gi;
            let xmlMatch: RegExpExecArray | null;
            while ((xmlMatch = writeRe.exec(toolXmlAccum || rawContent)) !== null) {
              const p = xmlMatch[1];
              if (p && !modifiedPaths.includes(p)) modifiedPaths.push(p);
            }

            setMessages(prev =>
              prev.map(m =>
                m.id === asstId
                  ? {
                      ...m,
                      content: finalContent,
                      status: 'complete' as const,
                      summary,
                      toolActivities,
                      filesModified: modifiedPaths.length > 0 ? modifiedPaths : undefined,
                    }
                  : m
              )
            );
```

- [ ] **Step 3: Append footer to history messages**

In the history-building block (where `history` is constructed from `recentTurns`), change:

```typescript
    const history = recentTurns.map(m => ({
      role: m.role as 'user' | 'assistant',
      // Content is already cleaned (ecomgear tags stripped on save/load)
      content: m.content,
    }));
```

To:

```typescript
    const history = recentTurns.map(m => {
      let content = m.content;
      // Append file-manifest footer so the agent knows which files were changed
      // in previous turns without needing to re-read the full history.
      if (m.role === 'assistant' && m.filesModified && m.filesModified.length > 0) {
        content = `${content}\n\n[Files modified in this response: ${m.filesModified.join(', ')}]`;
      }
      return { role: m.role as 'user' | 'assistant', content };
    });
```

- [ ] **Step 4: Verify no TypeScript errors in frontend**

```bash
cd /home/xer0bit/Desktop/ecomgear-main && npx tsc --noEmit 2>&1 | head -40
```

Expected: no new errors from `AgentChatPanel.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/AgentChatPanel.tsx
git commit -m "feat(chat): add filesModified to history so agent knows what changed in prior turns"
```

---

## Task 7: Final integration commit + verification

- [ ] **Step 1: Full TypeScript check**

```bash
cd /home/xer0bit/Desktop/ecomgear-main && npx tsc --noEmit 2>&1
cd /home/xer0bit/Desktop/ecomgear-main/server && npx tsc --noEmit 2>&1
```

Fix any new errors introduced by these changes (pre-existing errors are acceptable).

- [ ] **Step 2: Smoke test the agent manually**

Start the dev server and run an edit request on an existing project. Verify in the server logs:
- `[Brain] Step N: compacted ...` log line appears at step 6+ (not step 4)
- No crashes during `prepareStep`
- The agent's responses for edit requests now include dependency warnings when relevant

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: agent edit reliability — RunStateLedger, history augmentation, fuzzy match fix, dependency warnings, context tuning"
```
