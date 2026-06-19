import Stripe from 'https://esm.sh/stripe@18.5.0';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
};

const PRICE_PLAN_MAP = {
  price_1TAmb4Ckmi49M8D1I4VOHjjp: 'starter',
  price_1TAmb6Ckmi49M8D1dt2flpNM: 'professional',
} as const;

type OrgPlanTier = 'free' | 'starter' | 'professional' | 'enterprise';
type OrgStatus = 'active' | 'suspended' | 'cancelled';

function mapPriceToPlanTier(priceId?: string | null): OrgPlanTier {
  if (!priceId) return 'free';
  return PRICE_PLAN_MAP[priceId as keyof typeof PRICE_PLAN_MAP] || 'free';
}

function mapPlanTierToSubscriptionPlan(planTier: OrgPlanTier): 'free' | 'pro' | 'agency' {
  if (planTier === 'enterprise') return 'agency';
  if (planTier === 'starter' || planTier === 'professional') return 'pro';
  return 'free';
}

function mapStripeStatusToOrgStatus(status?: string | null): OrgStatus {
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

async function resolveOrganizationId(
  stripe: Stripe,
  supabase: ReturnType<typeof createClient>,
  subscription: Stripe.Subscription
): Promise<string | null> {
  const fromMetadata = subscription.metadata?.organization_id;
  if (fromMetadata) return fromMetadata;

  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;

  if (!customerId) return null;

  const customer = await stripe.customers.retrieve(customerId);
  if (!customer || customer.deleted) return null;

  const metaOrgId = customer.metadata?.organization_id;
  if (metaOrgId) return metaOrgId;

  const { data: orgBilling } = await supabase
    .from('organization_billing')
    .select('org_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  return orgBilling?.org_id || null;
}

async function syncSubscriptionToDatabase(
  stripe: Stripe,
  supabase: ReturnType<typeof createClient>,
  subscription: Stripe.Subscription
) {
  const orgId = await resolveOrganizationId(stripe, supabase, subscription);
  if (!orgId) {
    console.log('[STRIPE-WEBHOOK] Missing organization mapping for subscription', subscription.id);
    return;
  }

  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;
  const priceId = subscription.items.data[0]?.price?.id || null;

  // Check if this org has an admin-managed plan — if so, skip overwriting plan_tier
  const { data: orgRow } = await supabase
    .from('organizations')
    .select('admin_managed')
    .eq('id', orgId)
    .maybeSingle();

  const planTier = mapPriceToPlanTier(priceId);
  const orgStatus = planTier === 'free' ? 'active' : mapStripeStatusToOrgStatus(subscription.status);
  const periodStart = subscription.items.data[0]?.current_period_start
    ? new Date(subscription.items.data[0].current_period_start * 1000).toISOString()
    : null;
  const periodEnd = subscription.items.data[0]?.current_period_end
    ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
    : null;

  await supabase
    .from('subscriptions')
    .upsert({
      org_id: orgId,
      plan: mapPlanTierToSubscriptionPlan(planTier),
      status: subscription.status,
      stripe_subscription_id: subscription.id,
      stripe_price_id: priceId,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      cancel_at_period_end: subscription.cancel_at_period_end,
      canceled_at: subscription.canceled_at ? new Date(subscription.canceled_at * 1000).toISOString() : null,
      trial_start: subscription.trial_start ? new Date(subscription.trial_start * 1000).toISOString() : null,
      trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
      metadata: subscription.metadata,
    }, { onConflict: 'org_id' });

  // Only update the org plan when NOT admin-managed
  if (!orgRow?.admin_managed) {
    await supabase
      .from('organizations')
      .update({ plan_tier: planTier, status: orgStatus })
      .eq('id', orgId);
  } else {
    console.log('[STRIPE-WEBHOOK] Skipping plan_tier update — admin_managed org', { orgId });
  }

  if (customerId) {
    await supabase
      .from('organization_billing')
      .upsert({ org_id: orgId, stripe_customer_id: customerId }, { onConflict: 'org_id' });
  }

  console.log('[STRIPE-WEBHOOK] Synced subscription', {
    subscriptionId: subscription.id,
    orgId,
    planTier,
    status: subscription.status,
  });
}

async function suspendOrgFromInvoice(
  stripe: Stripe,
  supabase: ReturnType<typeof createClient>,
  invoice: Stripe.Invoice
) {
  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id;

  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price'],
  });

  const orgId = await resolveOrganizationId(stripe, supabase, subscription);
  if (!orgId) return;

  await supabase
    .from('organizations')
    .update({ status: 'suspended' })
    .eq('id', orgId);

  await supabase
    .from('subscriptions')
    .update({ status: 'past_due' })
    .eq('org_id', orgId);

  console.log('[STRIPE-WEBHOOK] Marked organization suspended from invoice.payment_failed', {
    orgId,
    invoiceId: invoice.id,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is not set');

    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
    const signature = req.headers.get('stripe-signature');
    const payload = await req.text();

    const stripe = new Stripe(stripeKey, { apiVersion: '2025-08-27.basil' });
    let event: Stripe.Event;

    if (webhookSecret && signature) {
      event = await stripe.webhooks.constructEventAsync(payload, signature, webhookSecret);
    } else {
      // Fallback while webhook secret is being finalized in environment.
      event = JSON.parse(payload) as Stripe.Event;
      console.warn('[STRIPE-WEBHOOK] Signature verification skipped (missing STRIPE_WEBHOOK_SECRET or stripe-signature)');
    }

    const supabase = createClient(
      Deno.env.get('EXTERNAL_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } }
    );

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const subscriptionId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id;
        if (!subscriptionId) break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['items.data.price'],
        });
        await syncSubscriptionToDatabase(stripe, supabase, subscription);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        const subscription = event.data.object as Stripe.Subscription;
        await syncSubscriptionToDatabase(stripe, supabase, subscription);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await suspendOrgFromInvoice(stripe, supabase, invoice);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = typeof invoice.subscription === 'string'
          ? invoice.subscription
          : invoice.subscription?.id;
        if (!subscriptionId) break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['items.data.price'],
        });
        await syncSubscriptionToDatabase(stripe, supabase, subscription);
        break;
      }

      default:
        console.log('[STRIPE-WEBHOOK] Ignored event', event.type);
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[STRIPE-WEBHOOK] Error', errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
