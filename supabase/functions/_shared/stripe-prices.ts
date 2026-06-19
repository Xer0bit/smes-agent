/**
 * Single source of truth for Stripe Price → Plan Tier mapping.
 * Used by edge functions: org-create-checkout, get-billing-info
 * Update here when Stripe prices change — no other file needs editing.
 */
export const STRIPE_PRICE_PLAN_MAP: Record<string, 'starter' | 'professional'> = {
  'price_1TAmb4Ckmi49M8D1I4VOHjjp': 'starter',
  'price_1TAmb6Ckmi49M8D1dt2flpNM': 'professional',
};

export type OrgPlanTier = 'free' | 'starter' | 'professional' | 'enterprise';

export function mapPriceIdToPlanTier(priceId?: string | null): OrgPlanTier {
  if (!priceId) return 'free';
  return STRIPE_PRICE_PLAN_MAP[priceId] ?? 'free';
}
