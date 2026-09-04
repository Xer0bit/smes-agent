-- No earlier migration ever created public.agent_locks, so a fresh database
-- (local dev, or a new single-server deploy) boots with the watchdog warning
-- "Could not find the table 'public.agent_locks'" and tryAcquireAgentLock in
-- ai.routes.ts fails for every run. Guarded so this is a no-op wherever the
-- table already exists, leaving an existing production shape untouched.
do $$
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'agent_locks'
  ) then
    create table public.agent_locks (
      project_id  uuid primary key,
      token       text not null,
      owner       text,
      acquired_at timestamptz not null default now()
    );
    -- Every caller (ai.routes.ts, agentRunWatchdog.service.ts, preview-service
    -- checkAgentLock) uses the service-role key, which bypasses RLS. No policies:
    -- anon must not be able to read lock tokens.
    alter table public.agent_locks enable row level security;
  end if;
end $$;
