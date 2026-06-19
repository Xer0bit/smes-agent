# Claude Code-Style Migration Plan for eComGear

## Goal
Shift agent execution from a best-effort loop to a deterministic coding workflow with clear phases:
1. Inspect
2. Plan
3. Edit
4. Verify
5. Finalize

This aligns behavior with Claude Code-style operation: small safe edits, explicit planning, continuous verification, and fast failure on repeated tool issues.

## Confirmed Product Decisions

1. Orchestrator: single host Docker (no Kubernetes for now).
2. Concurrency target: up to 30 simultaneously active projects.
3. Source of truth: Supabase Storage remains canonical.
4. Command policy: restricted execution, non-root user, npm install allowed under guardrails.

## Recommended Defaults (Best UX + Stable Ops)

1. Runtime model
- One hardened base image for preview workloads.
- One container per active project (do not build per-project images).
- Project workspace mounted into that container.

2. Cold-start target
- Target wake/start in 3-8 seconds for stopped projects.
- If startup exceeds 8 seconds, return a staged UI state: "Waking sandbox" with live progress.

3. Idle/offload policy
- Stop container after 10 minutes idle (free/starter).
- Stop container after 20 minutes idle (professional/enterprise).
- Keep metadata/state so reopen is fast and deterministic.

4. Capacity controls for 30 active projects
- Per container limits:
  - CPU: 0.5 core baseline, burst to 1.0
  - Memory: 768MB baseline, hard limit 1.5GB
  - PIDs: 256
  - Disk write quota on workspace mount
- Host-level admission control:
  - Max active containers = 30
  - Queue additional starts with FIFO + priority for paid tiers

5. Security profile
- Run as non-root user inside container.
- Read-only root filesystem where possible.
- Writable mounts only for project workspace and temp dir.
- Drop Linux capabilities, apply seccomp/apparmor profile.
- No Docker socket mount inside project containers.
- Network egress allowlist for npm registry + required package/CDN endpoints.

6. npm install guardrails
- Allow npm install only in project workspace.
- Per-run timeout for installs.
- Block lifecycle scripts if possible (`--ignore-scripts` for untrusted installs).
- Cache dependency tarballs centrally to reduce cold starts.

7. Persistence flow
- On every successful edit phase, sync changed files back to Supabase Storage.
- Container filesystem is a performance cache, never the source of truth.
- On container stop/delete, no data loss because canonical writes already persisted.

8. Project lifecycle behavior
- Project close: mark inactive, start idle timer, stop at timeout.
- Project reopen: recreate/start container from base image, hydrate workspace from storage snapshot.
- Project delete: immediate kill + volume/workspace cleanup + metadata cleanup.

9. Observability baseline
- Track run_id, project_id, container_id.
- Metrics: cold-start ms, active containers, queue wait, preview health, tool failure rate.
- Structured logs per phase for rapid support debugging.

## What Was Changed in Code

### 1) Workflow mode is now explicit
- Frontend request now sends `workflowMode` with default `claude_code`.
- Backend `/api/v1/agent/run` accepts and forwards this mode.
- Agent options type includes `workflowMode?: 'legacy' | 'claude_code'`.

### 2) Claude Code execution contract in backend loop
When `workflowMode=claude_code`, the backend injects an execution contract into the conversation:
- inspect files first
- plan before broad edits
- prefer minimal/surgical edits
- validate checklist + preview before finish
- stop quickly with blocker summary if tooling fails repeatedly

### 3) Stalled-loop guardrail
- Backend now tracks tool failures per turn.
- If tool failures happen for 3 consecutive turns, run stops with `TOOL_EXECUTION_STALLED` instead of looping indefinitely.

## Infrastructure Changes Needed (Important)

### A) Job execution model
Current: request/response style long-running SSE in API process.
Target:
- Introduce queue-backed run jobs (Redis or Postgres queue).
- API enqueues run and streams status from job state.
- Worker pool executes agent loops independently.

Why:
- prevents API worker lockups
- supports retries and cancel/resume
- isolates expensive runs from user-facing APIs

### B) Per-run execution sandbox
Current: preview exec endpoint reused for commands.
Target:
- ephemeral sandbox per run (container namespace + CPU/memory caps)
- strict filesystem mount scope to project path only
- command allowlist + timeout + network egress policy

Why:
- safer command execution
- deterministic runtime parity
- prevents cross-run contamination

### C) Event store and run timeline
Current: SSE tokens + partial logs.
Target:
- persist run events to DB: phase transitions, tool calls, tool outputs, token usage, preview checks, final status
- expose run timeline UI

Why:
- debuggability for "working flow issues"
- audit and support visibility
- easier failure classification

### D) Preview verification service hardening
Current: single preview health endpoint check.
Target:
- structured verification API returning machine-readable categories:
  - `build_error`
  - `runtime_error`
  - `missing_asset`
  - `router_error`
- automatic retry with fresh build before failing run

Why:
- fewer false negatives
- better repair prompts to model

### E) Observability and SLOs
Add:
- distributed trace id per run (`run_id`)
- metrics: run duration, tool failure ratio, preview fix attempts, token/use cost
- alerting on stall/failure spikes per model/provider

Why:
- control quality and cost
- identify regressions quickly

### F) Multi-model reliability routing
Current: single selected model with local retries.
Target:
- provider router with fallback sequence (Anthropic -> DeepSeek -> backup)
- health-based circuit breaker
- model-specific prompt/tool behavior profiles

Why:
- higher uptime
- fewer run failures due to provider incidents

## Suggested Rollout Path
1. Keep `claude_code` as default for local/dev only first.
2. Add run metrics dashboard and failure taxonomy.
3. Introduce queue + worker execution in staging.
4. Enable sandboxed command execution.
5. Roll out to production behind feature flag by org/project.

## Single-Host Docker Blueprint (Your Case)

### Control plane services on host
1. preview-control service
- Owns container lifecycle (start/stop/reap), idle timers, and capacity checks.

2. agent worker service
- Executes Claude Code-style phases and writes events/results.

3. queue service
- Redis recommended for low-latency run scheduling and delayed jobs.

4. reverse proxy
- Routes preview subpaths/domains to the correct active project container.

### Data model additions
1. project_runtime_instances
- project_id, container_id, status, started_at, last_active_at, stop_reason.

2. agent_run_events
- run_id, phase, event_type, payload, created_at.

3. agent_run_jobs
- run_id, project_id, status, queued_at, started_at, finished_at, error_code.

### Request flow
1. User opens project.
2. API checks active runtime; if absent, enqueue start job.
3. preview-control starts container and marks project active.
4. UI attaches to preview when health is ready.
5. During activity, heartbeat updates last_active_at.
6. Idle monitor stops container after tier timeout.

### Failure flow
1. Start failure -> job retries with bounded exponential backoff.
2. Repeated failure -> mark runtime degraded, show actionable error in UI.
3. Agent tool failures across 3 turns -> stop run with explicit stalled code (already implemented).

## Minimum infra for first production step
If you want quickest stable upgrade without full re-platform:
- Redis queue + worker process
- run event table in Postgres
- per-run timeout + cancel endpoint
- preview verification categories

This gives most reliability gains with moderate implementation effort.

## Immediate Next Implementation Order

1. Add queue and runtime instance tables.
2. Build preview-control lifecycle API on single host Docker.
3. Move agent execution to worker process (queue consumer).
4. Add heartbeat + idle reaper for 10/20 minute stop policy.
5. Add reverse-proxy dynamic routing to project containers.
6. Add run timeline UI from agent_run_events.
