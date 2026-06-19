-- Migration: project_secrets table
-- Stores per-project secret keys (API keys, tokens, etc.)
-- Values are stored in plaintext but access is RLS-restricted to project owners.

create table if not exists public.project_secrets (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  key_name    text not null,
  key_value   text not null,
  key_preview text not null default '****',
  created_at  timestamptz not null default now(),
  unique (project_id, key_name)
);

-- Index for fast lookup by project
create index if not exists project_secrets_project_id_idx on public.project_secrets (project_id);

-- RLS: owners/editors of the project can read/write their own secrets
alter table public.project_secrets enable row level security;

create policy "project_secrets_select" on public.project_secrets
  for select using (
    project_id in (
      select id from public.projects where user_id = auth.uid()
    )
    or project_id in (
      select project_id from public.project_members
      where user_id = auth.uid() and role = 'editor'
    )
  );

create policy "project_secrets_insert" on public.project_secrets
  for insert with check (
    project_id in (
      select id from public.projects where user_id = auth.uid()
    )
    or project_id in (
      select project_id from public.project_members
      where user_id = auth.uid() and role = 'editor'
    )
  );

create policy "project_secrets_delete" on public.project_secrets
  for delete using (
    project_id in (
      select id from public.projects where user_id = auth.uid()
    )
    or project_id in (
      select project_id from public.project_members
      where user_id = auth.uid() and role = 'editor'
    )
  );
