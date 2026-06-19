-- Enable Realtime for the jobs table
create table public.jobs (
  id uuid default gen_random_uuid() primary key,
  project_id uuid references public.projects(id),
  type text not null, -- 'generate', 'build', 'deploy', 'fix'
  status text not null default 'pending', -- 'pending', 'processing', 'completed', 'failed'
  payload jsonb default '{}'::jsonb,
  result jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable Realtime
alter publication supabase_realtime add table public.jobs;

-- RLS Policies
alter table public.jobs enable row level security;

create policy "Users can view their own jobs"
  on public.jobs for select
  using (auth.uid() in (select user_id from public.projects where id = project_id));

create policy "Users can create jobs for their projects"
  on public.jobs for insert
  with check (auth.uid() in (select user_id from public.projects where id = project_id));

-- Trigger to update updated_at
create extension if not exists moddatetime schema extensions;

create trigger handle_jobs_updated_at
  before update on public.jobs
  for each row execute procedure moddatetime (updated_at);
