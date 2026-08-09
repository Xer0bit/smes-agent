-- Create social_accounts table for connected social media accounts
create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null,
  account_name text not null,
  connected_at timestamptz not null default now()
);

alter table public.social_accounts enable row level security;

create policy "Admins can view accounts"
  on public.social_accounts for select to authenticated
  using (has_role(auth.uid(), 'admin'));

create policy "Admins can insert accounts"
  on public.social_accounts for insert to authenticated
  with check (has_role(auth.uid(), 'admin') and auth.uid() = user_id);

create policy "Admins can update accounts"
  on public.social_accounts for update to authenticated
  using (has_role(auth.uid(), 'admin'));

create policy "Admins can delete accounts"
  on public.social_accounts for delete to authenticated
  using (has_role(auth.uid(), 'admin'));

-- Add account_id to social_media_posts (nullable for backward compat)
alter table public.social_media_posts
  add column account_id uuid references public.social_accounts(id) on delete set null;
