-- Stripe-backed entitlements: remember which subscription set the quantities.
ALTER TABLE public.org_entitlements
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
