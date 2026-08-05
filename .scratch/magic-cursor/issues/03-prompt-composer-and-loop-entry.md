Status: needs-triage
Blocked by: 02

# Prompt composer + dedicated agent-loop entry path

## What

New `server/src/services/magicCursorPrompt.ts` implementing the spec Phase 2
template, plus a new entry branch in `agentLoopService.ts` (or a thin
pre-step before `runAgentLoop()`) that:
- skips `intentClassifier.ts` tiering and hybrid retrieval entirely (scope is
  already known — going through normal retrieval would defeat the whole
  point)
- feeds the composed prompt + region source directly as the initial context
- enforces "respond with `edit_file` per region, not `write_file`, unless a
  region's own boundaries must change" as an explicit instruction, not a
  post-hoc check
- parses the model's response for a `PROPOSED_ADDITIONAL_CHANGE` block and
  surfaces it structurally (not just left in prose) to the caller

## Approach

1. Template exactly as drafted in spec.md Phase 2 — region delimiters,
   verbatim user instruction, explicit "do not touch outside regions" /
   "do not reformat untouched lines" constraints.
2. Multi-region requests: each region gets its own delimited block with its
   own file/line-range header, per spec — never merge adjacent regions in
   the same file into one blob, even if lines are contiguous, so a partial
   failure (one region's SEARCH doesn't match) doesn't block the others.
3. Reuse the existing `edit_file` tool as-is (`agentLoopService.ts` ~2895) —
   this ticket does not touch its SEARCH/REPLACE matching logic at all.
4. After the model responds: for any `edit_file` call whose SEARCH block
   references a placeholder from ticket 02's extraction, splice the
   placeholder's real original bytes back in before diffing/applying (the
   model should echo the placeholder verbatim per the prompt instructions;
   this step is defensive in case it doesn't).
5. `PROPOSED_ADDITIONAL_CHANGE` parsing: simple structured block (e.g. a
   fenced section with a fixed header the prompt asks the model to use),
   extracted and returned as `{proposedChanges: string[]}` alongside the
   normal step/file results — never auto-executed.

## Acceptance

- A single-region request produces exactly one `edit_file` call scoped to
  that region's file/lines.
- A two-region, same-file request produces two independent `edit_file`
  calls, and a deliberately-broken first region (test: mutate the file
  between context extraction and model response so SEARCH won't match)
  doesn't prevent the second region's edit from landing.
- An instruction implying broader scope than the selection (test prompt:
  "make this red" on one button, instruction says "make all the buttons this
  color") produces a `PROPOSED_ADDITIONAL_CHANGE` and does NOT edit any file
  outside the selected region.
