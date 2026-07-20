import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { hasBillingAccess } from "../_shared/billing-access.ts";
import { STRIPE_PRICE_PLAN_MAP, mapPriceIdToPlanTier } from "../_shared/stripe-prices.ts";
import type { OrgPlanTier } from "../_shared/stripe-prices.ts";

const ALLOWED_ORIGINS = [
  'https://ecomgear.app', 'https://www.ecomgear.app',
  'https://ecomgear.dev', 'https://www.ecomgear.dev', 'https://1000.ecomgear.dev',
  'http://localhost:8080', 'http://localhost:3000',
];
const getCorsHeaders = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-external-authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Credentials': 'true',
  'Vary': 'Origin',
});

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[GET-BILLING-INFO] ${step}${detailsStr}`);
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Price → plan tier mapping is in _shared/stripe-prices.ts

type OrgBillingStatus = 'active' | 'suspended' | 'cancelled';

function mapPlanTierToSubscriptionPlan(planTier: OrgPlanTier): 'free' | 'pro' | 'agency' {
  switch (planTier) {
    case 'enterprise':
      return 'agency';
    case 'starter':
    case 'professional':
      return 'pro';
    default:
      return 'free';
  }
}

function mapStripeStatusToOrgStatus(status?: string | null): OrgBillingStatus {
  switch (status) {
    case 'trialing':
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'paused':
      return 'suspended';
    default:
      return 'cancelled';
  }
}

function pickRelevantSubscription(subscriptions: Stripe.Subscription[]): Stripe.Subscription | null {
  const priority = ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled', 'incomplete_expired'];
  const sorted = [...subscriptions].sort((left, right) => {
    const leftPriority = priority.indexOf(left.status);
    const rightPriority = priority.indexOf(right.status);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return (right.created || 0) - (left.created || 0);
  });

  return sorted[0] || null;
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    const supabaseClient = createClient(
      Deno.env.get("EXTERNAL_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("EXTERNAL_SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');

    const externalAuthHeader = req.headers.get("x-external-authorization");
    if (!externalAuthHeader) throw new HttpError(401, "No external authorization header");

    const token = externalAuthHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new HttpError(401, `Auth error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new HttpError(401, "User not authenticated");

    const url = new URL(req.url);
    const organization_id = url.searchParams.get('organization_id');

    if (!organization_id) throw new HttpError(400, "organization_id required");

    logStep("Checking billing admin permission", { user_id: user.id, organization_id });

    const isBillingAdmin = await hasBillingAccess(supabaseClient, organization_id, user.id);

    // Regular members should be able to see payment status for their own org.
    // Billing admins can additionally see sensitive billing identifiers.
    let isOrgMember = isBillingAdmin;
    if (!isOrgMember) {
      const { data: membership, error: membershipError } = await supabaseClient
        .from('org_members')
        .select('id')
        .eq('org_id', organization_id)
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();

      if (membershipError) {
        throw new HttpError(500, `Membership check error: ${membershipError.message}`);
      }

      isOrgMember = Boolean(membership);
    }

    if (!isOrgMember) {
      const { data: orgOwned, error: orgOwnedError } = await supabaseClient
        .from('organizations')
        .select('id')
        .eq('id', organization_id)
        .eq('created_by', user.id)
        .limit(1)
        .maybeSingle();

      if (orgOwnedError) {
        throw new HttpError(500, `Ownership check error: ${orgOwnedError.message}`);
      }

      isOrgMember = Boolean(orgOwned);
    }

    if (!isOrgMember) {
      throw new HttpError(403, "Not authorized for this organization");
    }

    logStep("Fetching billing information");

    // Get organization details including plan_tier and admin_managed flag
    const { data: org, error: orgError } = await supabaseClient
      .from('organizations')
      .select('name, plan_tier, status, admin_managed')
      .eq('id', organization_id)
      .single();

    if (orgError) throw new Error(`Organization error: ${orgError.message}`);

    // Get organization billing data (stripe info only)
    const { data: orgBilling, error: billingError } = await supabaseClient
      .from('organization_billing')
      .select('stripe_customer_id')
      .eq('org_id', organization_id)
      .maybeSingle();

    // Note: organization_billing might not exist yet, that's OK
    if (billingError) {
      logStep('organization_billing unavailable', { message: billingError.message });
    }

    let effectivePlanTier: OrgPlanTier = (org.plan_tier as OrgPlanTier) || 'free';
    let effectiveStatus: OrgBillingStatus = (org.status as OrgBillingStatus) || 'active';

    // When admin manually assigned the plan, skip Stripe sync to preserve it
    const isAdminManaged = org.admin_managed === true;
    if (isAdminManaged) {
      logStep('Skipping Stripe sync   admin_managed plan', { plan_tier: org.plan_tier });
    }

    if (stripeKey && orgBilling?.stripe_customer_id && !isAdminManaged) {
      try {
        const stripe = new Stripe(stripeKey, { apiVersion: '2025-08-27.basil' });
        const stripeSubscriptions = await stripe.subscriptions.list({
          customer: orgBilling.stripe_customer_id,
          status: 'all',
          limit: 10,
          expand: ['data.items.data.price'],
        });

        const relevantSubscription = pickRelevantSubscription(stripeSubscriptions.data);

        if (relevantSubscription) {
          const stripePriceId = relevantSubscription.items.data[0]?.price?.id || null;
          const nextPlanTier = mapPriceIdToPlanTier(stripePriceId);
          const nextStatus = nextPlanTier === 'free' ? 'active' : mapStripeStatusToOrgStatus(relevantSubscription.status);

          effectivePlanTier = nextPlanTier;
          effectiveStatus = nextStatus;

          await supabaseClient
            .from('subscriptions')
            .upsert({
              org_id: organization_id,
              plan: mapPlanTierToSubscriptionPlan(nextPlanTier),
              status: relevantSubscription.status,
              stripe_subscription_id: relevantSubscription.id,
              stripe_price_id: stripePriceId,
              current_period_start: relevantSubscription.items.data[0]?.current_period_start
                ? new Date(relevantSubscription.items.data[0].current_period_start * 1000).toISOString()
                : null,
              current_period_end: relevantSubscription.items.data[0]?.current_period_end
                ? new Date(relevantSubscription.items.data[0].current_period_end * 1000).toISOString()
                : null,
              cancel_at_period_end: relevantSubscription.cancel_at_period_end,
              canceled_at: relevantSubscription.canceled_at
                ? new Date(relevantSubscription.canceled_at * 1000).toISOString()
                : null,
              trial_start: relevantSubscription.trial_start
                ? new Date(relevantSubscription.trial_start * 1000).toISOString()
                : null,
              trial_end: relevantSubscription.trial_end
                ? new Date(relevantSubscription.trial_end * 1000).toISOString()
                : null,
              metadata: relevantSubscription.metadata,
            }, { onConflict: 'org_id' });

          if (org.plan_tier !== nextPlanTier || org.status !== nextStatus) {
            await supabaseClient
              .from('organizations')
              .update({ plan_tier: nextPlanTier, status: nextStatus })
              .eq('id', organization_id);
          }
        } else if (org.plan_tier !== 'free' || org.status !== 'active') {
          // No active Stripe subscription   downgrade to free only when NOT admin-managed
          effectivePlanTier = 'free';
          effectiveStatus = 'active';

          await supabaseClient
            .from('organizations')
            .update({ plan_tier: 'free', status: 'active' })
            .eq('id', organization_id);

          await supabaseClient
            .from('subscriptions')
            .upsert({
              org_id: organization_id,
              plan: 'free',
              status: 'canceled',
              stripe_subscription_id: null,
              stripe_price_id: null,
              current_period_start: null,
              current_period_end: null,
              cancel_at_period_end: false,
              canceled_at: new Date().toISOString(),
              trial_start: null,
              trial_end: null,
              metadata: {},
            }, { onConflict: 'org_id' });
        }
      } catch (stripeError) {
        logStep('stripe sync skipped', { message: stripeError instanceof Error ? stripeError.message : String(stripeError) });
      }
    }

    // Get recent invoices - using correct column name org_id
    const { data: invoices, error: invoicesError } = await supabaseClient
      .from('invoices')
      .select('*')
      .eq('org_id', organization_id)
      .order('created_at', { ascending: false })
      .limit(10);

    if (invoicesError) {
      logStep('invoices unavailable', { message: invoicesError.message });
    }

    // Get current month's project costs - using correct column name org_id
    const { data: projects, error: projectsError } = await supabaseClient
      .from('projects')
      .select('id, name')
      .eq('organization_id', organization_id);

    if (projectsError) {
      throw new HttpError(500, `Projects error: ${projectsError.message}`);
    }

    const projectCosts: any[] = [];
    let currentMonthTotal = 0;

    for (const project of projects || []) {
      const { data: addOns, error: addOnsError } = await supabaseClient
        .from('project_add_ons')
        .select('quantity, add_on_id')
        .eq('project_id', project.id)
        .eq('status', 'active');

      if (addOnsError) {
        logStep('project_add_ons unavailable', { project_id: project.id, message: addOnsError.message });
      }

      let projectTotal = 0;
      const addOnsList: any[] = [];

      for (const projectAddOn of addOns || []) {
        // Fetch add-on details
        const { data: addOnDetails, error: addOnDetailsError } = await supabaseClient
          .from('add_ons')
          .select('name, price_amount, billing_type')
          .eq('id', projectAddOn.add_on_id)
          .single();

        if (addOnDetailsError) {
          logStep('add_ons unavailable', { add_on_id: projectAddOn.add_on_id, message: addOnDetailsError.message });
        }

        if (!addOnDetails) continue;

        // Use single price_amount for all tiers
        const unitPrice = addOnDetails.price_amount;

        const cost = unitPrice * projectAddOn.quantity;
        projectTotal += cost;

        addOnsList.push({
          name: addOnDetails.name,
          quantity: projectAddOn.quantity,
          unit_price: unitPrice,
          cost: cost
        });
      }

      if (addOnsList.length > 0) {
        projectCosts.push({
          project_id: project.id,
          project_name: project.name,
          add_ons: addOnsList,
          total: projectTotal
        });
        currentMonthTotal += projectTotal;
      }
    }

    logStep("Billing info retrieved", {
      current_month_total: currentMonthTotal,
      invoice_count: invoices?.length
    });

    return new Response(JSON.stringify({
      organization_name: org.name,
      subscription_tier: effectivePlanTier,
      stripe_customer_id: isBillingAdmin ? (orgBilling?.stripe_customer_id || null) : null,
      current_month: {
        total: currentMonthTotal,
        projects: projectCosts
      },
      recent_invoices: invoices || []
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStatus = error instanceof HttpError ? error.status : 500;
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: errorStatus,
    });
  }
});
