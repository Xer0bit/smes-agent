-- Symbol-level graph: functions/components/hooks within a file, and the
-- calls/renders edges between them. Extends project_file_graph (file-level
-- imports/exports) one level down for fix/feature-tier traversal and
-- blast-radius queries (server/src/knowledgebase/symbolGraph.ts).

create table if not exists project_symbol_graph (
  id          uuid        primary key default gen_random_uuid(),
  project_id  uuid        not null references projects(id) on delete cascade,
  file_path   text        not null,
  symbol_name text        not null,
  kind        text        not null check (kind in ('function', 'component', 'hook', 'type')),
  calls       text[]      default '{}',    -- symbols this symbol calls
  renders     text[]      default '{}',    -- JSX components rendered in this symbol's body
  updated_at  timestamptz default now()
);

create index if not exists idx_symbol_graph_project
  on project_symbol_graph(project_id, file_path);

create index if not exists idx_symbol_graph_name
  on project_symbol_graph(project_id, symbol_name);

-- GIN indexes for fast array overlap queries (getCallers)
create index if not exists idx_symbol_graph_calls_gin
  on project_symbol_graph using gin(calls);

create index if not exists idx_symbol_graph_renders_gin
  on project_symbol_graph using gin(renders);

alter table project_symbol_graph enable row level security;

-- Same access pattern as project_file_graph (see 20260630010000_fix_kb_rls.sql):
-- service_role (production server), anon (server without service key configured),
-- and project owners (server using a user JWT).
create policy "kb_symbol_graph_access" on project_symbol_graph
  for all using (
    auth.role() = 'service_role'
    or auth.role() = 'anon'
    or project_id in (
      select id from projects where user_id = auth.uid()
    )
  );

create policy "admin_symbol_graph_read" on project_symbol_graph
  for select using (
    exists (
      select 1 from user_roles
      where user_id = auth.uid()
        and role in ('super_admin', 'admin')
    )
  );
