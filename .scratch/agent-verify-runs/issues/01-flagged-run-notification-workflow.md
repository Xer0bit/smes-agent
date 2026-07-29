Status: needs-triage

# Notify someone when a run is flagged

## What

A resolution workflow for flagged runs: when a customer clicks "Flag" on a
run, someone (org admin? support?) needs to be told, and there needs to be a
place flagged runs go until resolved. Right now Flag only marks the row —
nothing surfaces it beyond a badge in the list.

## Why

Deferred out of the "agent verify" design review
(`~/.claude/plans/agent-verify-runs.md`, Pass 7 / TODO 2) because it needs a
notification-channel decision (email vs in-app vs both) that review didn't
cover, and shouldn't block the core verify flow from shipping.

## Depends on / blocked by

- Notification infrastructure decision (not yet made)
- The core verify flow (Approve/Flag persisted state) shipping first —
  see spec.md in this directory

## Comments
