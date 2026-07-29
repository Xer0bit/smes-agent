Status: needs-triage

# getRun returns dead fields (completed_at, posts_generated)

## What

`agent-portal/services/mcp-server/src/tools/runs.ts:40,45` — `getRun()` reads
`r.completed_at` and `r.posts_generated` off the runs row. Neither column
exists on the `runs` table (`backend/src/db/schema.sql:121-134`). Both are
silently always `null`/`0` via the `??` fallback — no error, just dead data
presented as if live.

## Why

Found during plan-eng-review's outside-voice pass on the agent-verify-runs
plan (`~/.claude/plans/agent-verify-runs.md`). Not caused by that plan, not
blocking it — flagging so a future reader doesn't assume these fields are real.

## Depends on / blocked by

None. Either add the columns (if the data is wanted) or remove the dead
field mappings from `getRun`.

## Comments
