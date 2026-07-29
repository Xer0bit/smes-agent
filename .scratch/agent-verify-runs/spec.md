# Agent verify: make run review a first-class dashboard action

Status: ready-for-agent

## Why

The eCG agent-template dashboard is what a customer sees when they connect
their MCP key — it represents the company's reputation, not just a demo
shell. Today there's no way to easily verify what an agent actually did:
`RunsPage.tsx` rows only expand on error, `AgentDetailPage.tsx`'s "Recent
runs" card shows status/cost/duration but never the produced content, and
Run History is deliberately hidden from the sidebar nav (`HIDDEN_FROM_SIDEBAR`
in `Layout.tsx`) as an error-log concept. None of that supports "verify
smoothly, manage easily."

Full design decisions and rationale: see the design review plan at
`~/.claude/plans/agent-verify-runs.md` (design.md-calibrated, all 7 review
passes complete).

## Scope (this spec)

- Run History gets a permanent sidebar slot with a live "needs review" badge
- RunsPage row click expands to show run output + Approve/Flag actions
  (extends the existing error-only expansion to all statuses)
- Mobile (<768px): runs render as stacked cards, not a scrolled table
- AgentDetailPage's "Recent runs" card gains a reviewed/needs-review indicator
- Backend: `runs` gains `reviewed_at`/`reviewed_by`/`flagged`/`flag_note`
  columns + a review endpoint, mapped through the existing MCP-proxy pattern

## Comments
