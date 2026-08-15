-- ─── Fix: deleting an organization fails on org_members/org_invitations ─────
-- Reported error: "update or delete on table organizations violates foreign
-- key constraint org_members_org_id_fkey" -- 20260105133931_initial_schema.sql
-- defined org_members_org_id_fkey and org_invitations_org_id_fkey with no
-- ON DELETE clause (defaults to NO ACTION / blocks the parent delete), unlike
-- every later migration's org-scoped child tables, which consistently use
-- ON DELETE CASCADE (see e.g. 20260626000000_org_member_permissions.sql,
-- 20260219010000_subscription_system.sql). This is the initial schema
-- predating that convention, not an intentional divergence.
--
-- Scoped to pure access-control/membership tables only. Deliberately NOT
-- touching the other ~12 tables in the initial schema with the same missing
-- ON DELETE clause (invoices, billing_events, subscriptions, payment_methods,
-- credit_balances, usage_records, organization_billing, client_invoices,
-- agency_payouts, org_clients, agency_pricing, referrals) -- cascading a hard
-- delete on financial/billing history is a compliance/business decision, not
-- a bug fix. projects_org_id_fkey is also untouched: WorkspaceSettings.tsx's
-- handleDeleteOrg() already gives the user an explicit unassign-vs-delete-all
-- choice for linked projects, which a blind CASCADE would silently bypass.

ALTER TABLE public.org_members
  DROP CONSTRAINT org_members_org_id_fkey,
  ADD CONSTRAINT org_members_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.org_invitations
  DROP CONSTRAINT org_invitations_org_id_fkey,
  ADD CONSTRAINT org_invitations_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
