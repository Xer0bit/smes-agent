-- =============================================================================
-- Admin-managed plan override flag
-- Prevents Stripe sync from overwriting manually-set admin plans
-- =============================================================================

-- Add admin_managed flag to organizations
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS admin_managed BOOLEAN NOT NULL DEFAULT false;

-- Comment for clarity
COMMENT ON COLUMN public.organizations.admin_managed IS
  'When true, Stripe billing sync will NOT override plan_tier or status. '
  'Set by admin panel when manually assigning a plan.';
