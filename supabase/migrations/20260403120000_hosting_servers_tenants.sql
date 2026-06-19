-- ============================================================================
-- Multi-Server Tenant Lifecycle — hosting_servers, tenant_deployments, tenant_domains
-- ============================================================================

-- ── hosting_servers ─────────────────────────────────────────────────────────
-- Each row = one physical/virtual hosting node (VPS) that runs tenant Docker stacks.
create table if not exists public.hosting_servers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  public_ip     text not null,
  ssh_user      text not null default 'root',
  region        text not null default 'us-east',
  status        text not null default 'online'
                  check (status in ('online','offline','maintenance','draining')),
  api_key       text,                              -- bearer token hosting-service expects
  api_port      int  not null default 4000,        -- hosting-service port on this node
  capacity_total int not null default 20,          -- max tenants
  capacity_used  int not null default 0,
  node_name     text,                              -- PM2 / logical name
  caddy_api_url text,                              -- optional: Caddy admin URL
  health_status text not null default 'unknown'
                  check (health_status in ('healthy','degraded','unreachable','unknown')),
  health_last_check timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── tenant_deployments ──────────────────────────────────────────────────────
-- One deployment per project (tenant = project).
create table if not exists public.tenant_deployments (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects(id) on delete cascade,
  hosting_server_id   uuid not null references public.hosting_servers(id) on delete restrict,
  status              text not null default 'provisioning'
                        check (status in ('provisioning','running','suspended','stopped','failed','destroying')),
  -- Docker container ports on the host
  postgres_port       int,
  postgrest_port      int,
  edge_runtime_port   int,
  -- DB credentials (password encrypted at app layer before storage)
  db_name             text,
  db_password_enc     text,
  -- Container IDs for lifecycle management
  container_ids       jsonb not null default '{}',
  -- Domain routing
  subdomain           text,                        -- e.g. myapp.apps.ecomgear.app
  custom_domain       text,
  -- Timestamps
  deployed_at         timestamptz,
  last_deploy_at      timestamptz,
  suspended_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Only one active deployment per project
  constraint uq_tenant_project unique (project_id)
);

-- ── tenant_domains ──────────────────────────────────────────────────────────
-- Custom domains attached to a tenant deployment (extends project_custom_domains).
create table if not exists public.tenant_domains (
  id                    uuid primary key default gen_random_uuid(),
  tenant_deployment_id  uuid not null references public.tenant_deployments(id) on delete cascade,
  hosting_server_id     uuid not null references public.hosting_servers(id) on delete restrict,
  domain                text not null unique,
  dns_status            text not null default 'pending_dns'
                          check (dns_status in ('pending_dns','verified','active','failed')),
  ssl_status            text not null default 'pending'
                          check (ssl_status in ('pending','provisioning','active','failed')),
  verified_at           timestamptz,
  activated_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
create index if not exists idx_tenant_deployments_server
  on public.tenant_deployments(hosting_server_id);
create index if not exists idx_tenant_deployments_status
  on public.tenant_deployments(status);
create index if not exists idx_tenant_domains_deployment
  on public.tenant_domains(tenant_deployment_id);
create index if not exists idx_hosting_servers_status
  on public.hosting_servers(status);

-- ── updated_at triggers ─────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_hosting_servers_updated
  before update on public.hosting_servers
  for each row execute function public.set_updated_at();

create trigger trg_tenant_deployments_updated
  before update on public.tenant_deployments
  for each row execute function public.set_updated_at();

create trigger trg_tenant_domains_updated
  before update on public.tenant_domains
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.hosting_servers enable row level security;
alter table public.tenant_deployments enable row level security;
alter table public.tenant_domains enable row level security;

-- Admin-only policies (super_admin / admin role)
create policy "Admins can manage hosting_servers"
  on public.hosting_servers for all
  using (
    exists (
      select 1 from public.user_roles
      where user_id = auth.uid()
        and role in ('super_admin','admin')
    )
  );

create policy "Admins can manage tenant_deployments"
  on public.tenant_deployments for all
  using (
    exists (
      select 1 from public.user_roles
      where user_id = auth.uid()
        and role in ('super_admin','admin')
    )
  );

create policy "Admins can manage tenant_domains"
  on public.tenant_domains for all
  using (
    exists (
      select 1 from public.user_roles
      where user_id = auth.uid()
        and role in ('super_admin','admin')
    )
  );

-- Service role bypass (for backend calls)
create policy "Service role full access hosting_servers"
  on public.hosting_servers for all
  using (auth.role() = 'service_role');

create policy "Service role full access tenant_deployments"
  on public.tenant_deployments for all
  using (auth.role() = 'service_role');

create policy "Service role full access tenant_domains"
  on public.tenant_domains for all
  using (auth.role() = 'service_role');
