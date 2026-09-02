-- Unit pricing: one base plan (SINGLE) plus $19 units.
--
--   Base SINGLE   includes 1 App, 1 User, 1 Agent, 1 Database, OneNET, OneMAIL
--   + Additional Apps / Users / Agents / Databases   $19 per unit per month
--
-- `billing_catalog` is the single editable price list (admin). Each
-- organization buys quantities in `org_entitlements`; usage must stay within
-- them (projects, members, agents, hosted databases), enforced at the routes
-- that create each unit. Missing entitlements row = the base plan.

CREATE TABLE IF NOT EXISTS public.billing_catalog (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  currency              text NOT NULL DEFAULT 'USD',
  base_price_cents      integer NOT NULL,
  app_price_cents       integer NOT NULL,
  user_price_cents      integer NOT NULL,
  agent_price_cents     integer NOT NULL,
  database_price_cents  integer NOT NULL,
  included_apps         integer NOT NULL DEFAULT 1,
  included_users        integer NOT NULL DEFAULT 1,
  included_agents       integer NOT NULL DEFAULT 1,
  included_databases    integer NOT NULL DEFAULT 1,
  -- Fair-use allowance of agent work per app per month, in eco (1 eco ~ $0.05
  -- of model cost). A flat $19 app cannot carry unbounded generation.
  included_eco_per_app  integer NOT NULL DEFAULT 150,
  overage_policy        text NOT NULL DEFAULT 'stop' CHECK (overage_policy IN ('stop', 'allow')),
  includes              text[] NOT NULL DEFAULT ARRAY['OneNET', 'OneMAIL'],
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid
);

INSERT INTO public.billing_catalog (id, name, base_price_cents, app_price_cents, user_price_cents, agent_price_cents, database_price_cents)
VALUES ('single', 'SINGLE', 1900, 1900, 1900, 1900, 1900)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.org_entitlements (
  org_id      uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_id     text NOT NULL DEFAULT 'single' REFERENCES public.billing_catalog(id),
  apps        integer NOT NULL DEFAULT 1 CHECK (apps >= 0),
  users       integer NOT NULL DEFAULT 1 CHECK (users >= 0),
  agents      integer NOT NULL DEFAULT 1 CHECK (agents >= 0),
  databases   integer NOT NULL DEFAULT 1 CHECK (databases >= 0),
  -- null = catalog default
  eco_per_app integer,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'stripe', 'admin')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

ALTER TABLE public.billing_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_entitlements ENABLE ROW LEVEL SECURITY;

-- Prices are public to signed-in users; writes only through the service role.
DROP POLICY IF EXISTS "catalog_read" ON public.billing_catalog;
CREATE POLICY "catalog_read" ON public.billing_catalog FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "catalog_service" ON public.billing_catalog;
CREATE POLICY "catalog_service" ON public.billing_catalog FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "entitlements_member_read" ON public.org_entitlements;
CREATE POLICY "entitlements_member_read" ON public.org_entitlements FOR SELECT
  USING (auth.uid() IN (SELECT user_id FROM public.org_members WHERE org_id = org_entitlements.org_id));
DROP POLICY IF EXISTS "entitlements_service" ON public.org_entitlements;
CREATE POLICY "entitlements_service" ON public.org_entitlements FOR ALL TO service_role USING (true) WITH CHECK (true);

-- What an organization is using right now, per unit. Counted live so the
-- plan page and the gates never disagree with the tables.
CREATE OR REPLACE FUNCTION public.org_unit_usage(p_org_id uuid)
RETURNS TABLE (apps integer, users integer, agents integer, databases integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (SELECT count(*)::int FROM public.projects p WHERE p.organization_id = p_org_id AND p.status = 'active') AS apps,
    (SELECT count(*)::int FROM public.org_members m WHERE m.org_id = p_org_id) AS users,
    (SELECT count(*)::int FROM public.ai_agents a
       WHERE a.user_id IN (SELECT user_id FROM public.org_members WHERE org_id = p_org_id)
         AND COALESCE(a.is_active, true)) AS agents,
    (SELECT count(*)::int FROM public.tenant_databases t WHERE t.organization_id = p_org_id AND t.status = 'active') AS databases;
$$;

-- Enforcement at the table, so every writer (API, web client inserts, admin
-- tools) meets the same limit. Refuses one past the purchased quantity.
CREATE OR REPLACE FUNCTION public.assert_org_unit_capacity(p_org_id uuid, p_unit text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_purchased integer;
  v_used integer;
  v_label text;
BEGIN
  IF p_org_id IS NULL THEN RETURN; END IF;
  SELECT CASE p_unit WHEN 'apps' THEN e.apps WHEN 'users' THEN e.users WHEN 'agents' THEN e.agents ELSE e.databases END
    INTO v_purchased FROM public.org_entitlements e WHERE e.org_id = p_org_id;
  IF v_purchased IS NULL THEN
    SELECT CASE p_unit WHEN 'apps' THEN c.included_apps WHEN 'users' THEN c.included_users WHEN 'agents' THEN c.included_agents ELSE c.included_databases END
      INTO v_purchased FROM public.billing_catalog c WHERE c.id = 'single';
  END IF;
  SELECT CASE p_unit WHEN 'apps' THEN u.apps WHEN 'users' THEN u.users WHEN 'agents' THEN u.agents ELSE u.databases END
    INTO v_used FROM public.org_unit_usage(p_org_id) u;
  IF v_used >= COALESCE(v_purchased, 0) THEN
    v_label := CASE p_unit WHEN 'apps' THEN 'app' WHEN 'users' THEN 'user' WHEN 'agents' THEN 'agent' ELSE 'database' END;
    RAISE EXCEPTION 'UNIT_LIMIT: this workspace has % %(s) on its plan and is using %. Add another % in Settings > Plan.',
      COALESCE(v_purchased, 0), v_label, v_used, v_label USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_projects_unit_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS NOT NULL AND NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR OLD.organization_id IS DISTINCT FROM NEW.organization_id OR OLD.status <> 'active') THEN
    PERFORM public.assert_org_unit_capacity(NEW.organization_id, 'apps');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS projects_unit_capacity ON public.projects;
CREATE TRIGGER projects_unit_capacity BEFORE INSERT OR UPDATE OF organization_id, status ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.trg_projects_unit_capacity();

CREATE OR REPLACE FUNCTION public.trg_org_members_unit_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.assert_org_unit_capacity(NEW.org_id, 'users');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS org_members_unit_capacity ON public.org_members;
CREATE TRIGGER org_members_unit_capacity BEFORE INSERT ON public.org_members
  FOR EACH ROW EXECUTE FUNCTION public.trg_org_members_unit_capacity();

CREATE OR REPLACE FUNCTION public.trg_tenant_databases_unit_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS NOT NULL AND NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active') THEN
    PERFORM public.assert_org_unit_capacity(NEW.organization_id, 'databases');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tenant_databases_unit_capacity ON public.tenant_databases;
CREATE TRIGGER tenant_databases_unit_capacity BEFORE INSERT OR UPDATE OF status ON public.tenant_databases
  FOR EACH ROW EXECUTE FUNCTION public.trg_tenant_databases_unit_capacity();

-- Grandfather existing workspaces: seed entitlements at max(included, in use)
-- so nobody is blocked on the day this ships. Admin adjusts from there.
INSERT INTO public.org_entitlements (org_id, plan_id, apps, users, agents, databases, source)
SELECT o.id, 'single',
       GREATEST(c.included_apps, u.apps), GREATEST(c.included_users, u.users),
       GREATEST(c.included_agents, u.agents), GREATEST(c.included_databases, u.databases), 'manual'
FROM public.organizations o
CROSS JOIN public.billing_catalog c
CROSS JOIN LATERAL public.org_unit_usage(o.id) u
WHERE c.id = 'single'
ON CONFLICT (org_id) DO NOTHING;

-- Every workspace is live on the base plan. 'pending_approval' was the column
-- default with no approval flow behind it, so new workspaces showed a red
-- badge forever.
ALTER TABLE public.organizations ALTER COLUMN status SET DEFAULT 'active';
UPDATE public.organizations SET status = 'active' WHERE status = 'pending_approval';
