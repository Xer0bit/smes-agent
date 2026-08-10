-- Social Template v2 — hosted-DB schema (tier 2: PostgreSQL + PostgREST only,
-- NO Supabase Auth/auth.users/auth.uid() in this database — identity lives in
-- the platform's separate cloud auth service and is verified inside edge
-- functions, never at the Postgres/RLS layer). See src/edge-functions/*.js
-- for the only code paths permitted to touch these tables; the frontend
-- never queries them directly (src/lib/tenant.ts only calls edge functions).
--
-- RLS: every table is deny-all to anon/service by platform default the
-- instant it is created (zero policies). That default IS the desired
-- posture here — no policy is added anywhere in this file. All access goes
-- through edge functions, whose db.* helper runs with a trusted, RLS-
-- bypassing credential (requires_service_role defaults to true), and each
-- function enforces authorization itself in JS after verifying the caller's
-- cloud-auth access token.

create type public.app_role as enum ('admin', 'member');
create type public.post_status as enum ('draft', 'scheduled', 'published', 'failed');
create type public.press_status as enum ('draft', 'submitted', 'published', 'unpublished');
create type public.social_platform as enum ('twitter', 'facebook', 'instagram', 'linkedin', 'youtube');

-- ── Identity mirror ──────────────────────────────────────────────────────────
-- One row per cloud-auth user this app has seen. auth_user_id is the cloud
-- auth service's user id (a plain UUID column -- there is no FK target for
-- it in this database, the two systems are separate services). Rows are
-- created lazily by the auth-context edge function on a user's first
-- successful call, not by a Postgres trigger (no cross-service trigger is
-- possible here).
create table public.profiles (
  auth_user_id uuid primary key,
  email text not null,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The very first profile ever created for this tenant is auto-promoted to
-- 'admin' by the auth-context function (bootstrap owner); every user after
-- that has no role until an existing admin grants one via the Team page.
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references public.profiles(auth_user_id) on delete cascade,
  role public.app_role not null,
  unique (auth_user_id, role)
);

-- ── Clients + membership ─────────────────────────────────────────────────────
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- auth_user_id is nullable: an admin can grant a client-portal login to an
-- email before that person has ever signed up (invited_email holds the
-- claim key). auth-context.js claims any matching pending row -- filling in
-- auth_user_id and clearing invited_email -- the first time that email
-- signs in. This exists because edge functions have no admin API for the
-- cloud auth service (no way to create a password-set account server-side,
-- unlike Lovable's Supabase-monolith original -- see spec.md's gaps list),
-- so invite-then-self-signup is the only account-provisioning path available.
create table public.client_users (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  auth_user_id uuid references public.profiles(auth_user_id) on delete cascade,
  invited_email text,
  check (auth_user_id is not null or invited_email is not null),
  unique (client_id, auth_user_id),
  unique (client_id, invited_email)
);

-- ── Lead forms + leads ───────────────────────────────────────────────────────
create table public.lead_forms (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  form_name text not null,
  webhook_url text,
  created_at timestamptz not null default now()
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  lead_form_id uuid references public.lead_forms(id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ── Press releases ───────────────────────────────────────────────────────────
create table public.press_releases (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  title text not null,
  content text not null default '',
  status public.press_status not null default 'draft',
  admin_comment text,
  published_url text,
  total_visits integer not null default 0,
  unique_visits integer not null default 0,
  created_by uuid references public.profiles(auth_user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.press_release_urls (
  id uuid primary key default gen_random_uuid(),
  press_release_id uuid not null references public.press_releases(id) on delete cascade,
  url text not null,
  outlet_name text,
  total_visits integer not null default 0,
  unique_visits integer not null default 0,
  created_at timestamptz not null default now()
);

-- ── Files ────────────────────────────────────────────────────────────────────
-- This platform's hosted DB has no Supabase-Storage-style object bucket, so
-- small files (brand assets, post media) are stored as base64 in Postgres
-- and served back as data: URLs by the files edge function. Fine for
-- images/logos; NOT a fit for large video -- documented ceiling, not a
-- silent limitation (see files.js).
create table public.app_files (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  file_name text not null,
  mime_type text not null,
  data_base64 text not null,
  uploaded_by uuid references public.profiles(auth_user_id) on delete set null,
  created_at timestamptz not null default now()
);

-- ── Brand assets ─────────────────────────────────────────────────────────────
create table public.brand_assets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  asset_type text not null,
  file_name text not null,
  file_id uuid references public.app_files(id) on delete set null,
  description text,
  revision integer not null default 1,
  uploaded_by uuid references public.profiles(auth_user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Social accounts + posts + analytics ──────────────────────────────────────
-- No mcp_url/mcp_tool_name/webhook_url columns -- publishing goes through
-- the Agent Portal's Buffer connector (social.js), never Zapier.
create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  platform text not null,
  account_name text not null,
  page_config jsonb,
  connected_at timestamptz not null default now()
);

create table public.social_media_posts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  account_id uuid references public.social_accounts(id) on delete set null,
  created_by uuid references public.profiles(auth_user_id) on delete set null,
  content text not null,
  platforms public.social_platform[] not null default '{}',
  status public.post_status not null default 'draft',
  media_file_ids uuid[] default '{}',
  -- Agent Portal planned-post id once published through create_post.
  external_post_id text,
  -- Per-platform extras (link_url, cta, hashtags, video fields…) keyed by
  -- platform — see SocialMedia.tsx's PlatformData.
  platform_data jsonb,
  scheduled_at timestamptz,
  published_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.post_analytics (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_media_posts(id) on delete cascade,
  platform text not null,
  impressions integer not null default 0,
  likes integer not null default 0,
  comments integer not null default 0,
  shares integer not null default 0,
  clicks integer not null default 0,
  fetched_at timestamptz not null default now()
);
