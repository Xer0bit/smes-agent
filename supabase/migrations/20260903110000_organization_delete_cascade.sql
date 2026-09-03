-- Deleting an organization from the admin panel failed with
--   update or delete on table "organizations" violates foreign key constraint
--   "projects_org_id_fkey" on table "projects"
-- because every reference to organizations was a bare FK with no ON DELETE
-- rule. Projects and agent runs are kept (detached from the workspace);
-- org-scoped billing, referral and agency rows go with the organization.

ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_org_id_fkey;
ALTER TABLE public.projects ADD CONSTRAINT projects_org_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL;

ALTER TABLE public.agent_runs DROP CONSTRAINT IF EXISTS agent_runs_organization_id_fkey;
ALTER TABLE public.agent_runs ADD CONSTRAINT agent_runs_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL;

ALTER TABLE public.referrals DROP CONSTRAINT IF EXISTS referrals_referrer_org_id_fkey;
ALTER TABLE public.referrals ADD CONSTRAINT referrals_referrer_org_id_fkey
  FOREIGN KEY (referrer_org_id) REFERENCES public.organizations(id) ON DELETE SET NULL;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.confrelid = 'public.organizations'::regclass
      AND c.contype = 'f'
      AND c.conrelid::regclass::text IN (
        'subscriptions', 'usage_records', 'billing_events', 'invoices', 'credit_balances',
        'organization_billing', 'payment_methods', 'org_clients', 'agency_pricing',
        'agency_payouts', 'client_invoices')
      AND pg_get_constraintdef(c.oid) NOT ILIKE '%ON DELETE%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.organizations(id) ON DELETE CASCADE',
                   r.tbl, r.conname, r.col);
  END LOOP;
END $$;
