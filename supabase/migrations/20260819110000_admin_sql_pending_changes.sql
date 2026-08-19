-- Admin-mode agent chat (2026-08-19): the agent's existing query_database
-- tool already runs arbitrary SQL (DDL+DML) against a project's tenant DB
-- with full service-role access, unconditionally in every chat session --
-- and its confirmation step (confirm_database_change) is called by the
-- agent itself in the same run, which is not a real safety gate: a model
-- that decided a write was safe would just as readily decide to confirm it.
--
-- Two changes land alongside this table: (1) query_database/
-- confirm_database_change/test_database_function/provision_database are now
-- gated to an explicit "admin mode" the user opts a chat session into, not
-- available by default; (2) a dangerous admin-mode statement (schema-
-- mutating, or an unqualified UPDATE/DELETE) is staged HERE instead of an
-- in-memory Map, and can only be executed by a real HTTP request a human
-- triggers by clicking a button in the chat UI -- the agent has no tool
-- that can confirm its own pending change.
create table public.admin_sql_pending_changes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  staged_by_user_id uuid not null references auth.users(id) on delete cascade,
  sql_text text not null,
  status text not null default 'pending' check (status in ('pending', 'executed', 'rejected', 'expired')),
  created_at timestamptz not null default now(),
  executed_at timestamptz,
  executed_by_user_id uuid references auth.users(id),
  error_message text
);

create index admin_sql_pending_changes_project_status_idx
  on public.admin_sql_pending_changes (project_id, status, created_at desc);

alter table public.admin_sql_pending_changes enable row level security;

-- Same access rule as query_database's own 'service' role gate (requireProjectEdit):
-- anyone with edit access to the project can see and act on pending admin SQL,
-- matching this feature's explicit "any authenticated collaborator" scope.
create policy "Project editors can view pending admin SQL"
  on public.admin_sql_pending_changes for select
  using (public.has_project_access(project_id));

-- Inserts/updates only ever happen through the API server (service role),
-- never directly from a client -- staging happens inside query_database's
-- own tool execution, execution happens inside the confirm route, both
-- already re-checking project access themselves. No client-writable policy.
