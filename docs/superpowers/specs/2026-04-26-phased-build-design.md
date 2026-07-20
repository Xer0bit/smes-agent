# Phased Build   Design Spec
Date: 2026-04-26

## Problem
When a user submits a large requirement (many pages, features), the agent tries to build everything in a single 25-step run. This exhausts the token/step limit and the user sees an error. The plan mode also outputs a verbose wall of text instead of a concise structure.

## Solution (Approach A   Prompt-only)
Two coordinated prompt changes: (1) plan mode outputs a compact site tree + phase breakdown, (2) build mode reads history to determine which phase is next and builds only that phase, then pauses and asks the user to continue.

No backend state, no DB changes. The agent self-navigates phases using conversation history.

---

## Section 1   Plan Mode Output Format

**File:** `server/src/services/agentLoopService.ts`   `modeInstruction` for `plan`

Change the plan mode runtime instruction to require this exact output structure:

```
## Site Map
[Section]
├── [Page/Component] · [Page/Component]

[Section]
├── [Page/Component] · [Page/Component]

## Phases
Phase 1   [description of pages/sections]
Phase 2   [description]
Phase 3   [description] (add more if needed)

Reply **execute** to start Phase 1.
```

Rules for the agent:
- No verbose descriptions, no code, no architecture prose
- Each phase should be buildable in ~8–12 agent steps (a few pages + wiring)
- The site map uses tree notation (├── leaf · leaf)
- End with exactly `Reply **execute** to start Phase 1.`
- Only trigger plan mode for prompts detected as long/structured (existing `shouldAutoPlan` logic unchanged)

---

## Section 2   Build Mode Phase Awareness

**File:** `server/src/services/agentLoopService.ts`   `modeInstruction` for `build`

Add to the build mode runtime instruction:

> If the conversation history contains a phase plan (look for `## Phases` + `Phase N  ` lines), you are in phased build mode. Count how many "Phase N done ✓" messages already appear in the history to determine the current phase number. Build ONLY the files needed for that phase. When all files for the phase are written and verified, end your final message with exactly:
>
> `Phase N done ✓   ready to build Phase N+1 ([one-line description])? Reply **continue** to proceed.`
>
> If this is the last phase, instead write: `All phases complete ✓   your app is ready.`
>
> Do NOT build files from future phases. Do NOT skip the phase-done line.

---

## Section 3   Trigger Detection

**File:** `server/src/routes/ai.routes.ts`   `EXECUTE_BUILD_RE`

Add `continue` and `go` to the regex so user replies to phase-done messages route to build mode:

```ts
// Before
const EXECUTE_BUILD_RE = /\b(execute|build it|apply|start building)\b/i;

// After
const EXECUTE_BUILD_RE = /\b(execute|build it|apply|start building|continue|go)\b/i;
```

---

## Data Flow

```
User: [long requirement]
  → shouldAutoPlan → plan mode
  → Agent outputs: site map tree + Phase 1/2/3 breakdown
  → "Reply execute to start Phase 1"

User: execute
  → EXECUTE_BUILD_RE matches → build mode
  → Agent reads history: sees phase plan, 0 "done" messages → builds Phase 1
  → Ends: "Phase 1 done ✓   ready for Phase 2? Reply continue"

User: continue
  → EXECUTE_BUILD_RE matches → build mode
  → Agent reads history: sees 1 "done" message → builds Phase 2
  → Ends: "Phase 2 done ✓   ready for Phase 3? Reply continue"

User: continue
  → Agent builds Phase 3 → "All phases complete ✓"
```

---

## Files Changed

| File | Change |
|------|--------|
| `server/src/services/agentLoopService.ts` | Plan mode instruction: compact site tree format. Build mode instruction: phase detection + phase-done line. |
| `server/src/routes/ai.routes.ts` | `EXECUTE_BUILD_RE`: add `continue` and `go` |

No new files. No DB changes. No frontend changes.

---

## Out of Scope
- Storing phase state in Supabase (Approach C)
- Frontend "Continue" button (can be added later)
- Per-phase progress indicator in UI
