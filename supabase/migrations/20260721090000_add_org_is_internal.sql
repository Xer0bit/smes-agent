-- Rebuild plan Task 1.4: tag internal (dogfooding) accounts so usage/cost/abort
-- analysis can separate them from real customers. Production audit 2026-07-21:
-- two internal accounts produced 81% of all budget-cap aborts, polluting every
-- aggregate metric.
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.is_internal IS
  'True for team/dogfooding orgs. Exclude from customer-facing usage, cost, and abort aggregations.';

-- Seed: the two orgs identified in the audit.
--   73087235: Muhammad Sameer''s Workspace (founder)
--   249ed9e1: 38 Digital (agency org both power users belong to)
-- Other orgs owned by the same people (CardPro, eCG, Falconic Tech) can be
-- added later with a plain UPDATE if their traffic warrants it.
UPDATE public.organizations SET is_internal = true
  WHERE id IN ('73087235-d558-4054-8397-aedbffb6cb0a', '249ed9e1-9611-4a8c-9bb5-8d67936ac48f');
