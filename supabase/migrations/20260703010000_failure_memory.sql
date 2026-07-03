-- Failure memory: error signature -> verified fix (mechanical patch or LLM diff)
-- that cleared it. Checked before escalating a build error to the LLM repair
-- agent (server/src/services/agentLoopService.ts, PASS -1 before mechanical repair).
-- Only stores outcomes where the build passed AFTER applying the fix — grounded
-- in verified results, not LLM self-report, so it doesn't drift like a summary would.
--
-- Keyed globally (not per-project) on error signature: the same "Cannot find
-- module X" or bracket-imbalance pattern recurs across projects and templates,
-- so a fix learned once benefits the whole fleet on the next occurrence.

create table if not exists agent_failure_memory (
  id              uuid        primary key default gen_random_uuid(),
  error_signature text        not null unique,   -- normalized error message + file extension
  fix_kind        text        not null check (fix_kind in ('mechanical', 'llm_diff')),
  fix_content     text        not null,          -- mechanical: sanitizer rule name; llm_diff: the SEARCH/REPLACE diff
  hit_count       int         not null default 1,
  last_used_at    timestamptz default now(),
  created_at      timestamptz default now()
);

create index if not exists idx_failure_memory_last_used
  on agent_failure_memory(last_used_at);

alter table agent_failure_memory enable row level security;

-- Same access pattern as the other KB tables — service_role in production,
-- anon fallback when no service key is configured. No project_id column here
-- (memory is intentionally global), so no per-project ownership check applies.
create policy "failure_memory_access" on agent_failure_memory
  for all using (
    auth.role() = 'service_role'
    or auth.role() = 'anon'
  );

create policy "admin_failure_memory_read" on agent_failure_memory
  for select using (
    exists (
      select 1 from user_roles
      where user_id = auth.uid()
        and role in ('super_admin', 'admin')
    )
  );
