-- Create table for storing project chat history
create table if not exists public.project_chat_history (
  id uuid default gen_random_uuid() primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid references auth.users(id),
  role text not null check (role in ('user', 'assistant', 'system')),
  content text,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- Enable RLS
alter table public.project_chat_history enable row level security;

-- Policies
create policy "Users can view chat history for their projects"
  on public.project_chat_history for select
  using (
    exists (
      select 1 from public.projects
      where projects.id = project_chat_history.project_id
      and projects.user_id = auth.uid()
    )
  );

create policy "Users can insert chat messages for their projects"
  on public.project_chat_history for insert
  with check (
    exists (
      select 1 from public.projects
      where projects.id = project_chat_history.project_id
      and projects.user_id = auth.uid()
    )
  );
