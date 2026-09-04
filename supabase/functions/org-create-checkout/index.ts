import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { hasBillingAccess } from "../_shared/billing-access.ts";
import { STRIPE_PRICE_PLAN_MAP } from "../_shared/stripe-prices.ts";

const ALLOWED_ORIGINS = [
  'https://SMEsAgent.app', 'https://www.SMEsAgent.app',
  'https://SMEsAgent.dev', 'https://www.SMEsAgent.dev', 'https://1000.SMEsAgent.dev',
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
  console.log(`[ORG-CREATE-CHECKOUT] ${step}${detailsStr}`);
};

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get('EXTERNAL_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } }
  );

  try {
    logStep('Function started');

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) throw new Error('STRIPE_SECRET_KEY is not set');
    logStep('Stripe key verified');

    const externalAuthHeader = req.headers.get('x-external-authorization');
    if (!externalAuthHeader) throw new Error('No external authorization header provided');

    const token = externalAuthHeader.replace('Bearer ', '');
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error('User not authenticated or email not available');
    logStep('User authenticated', { userId: user.id, email: user.email });

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const priceId = body.priceId as string | undefined;
    const organizationId = body.organization_id || body.organizationId;
    const planTier = priceId ? STRIPE_PRICE_PLAN_MAP[priceId as keyof typeof STRIPE_PRICE_PLAN_MAP] : undefined;

    if (!priceId) throw new Error('Price ID is required');
    if (!organizationId) throw new Error('organization_id required');
    if (!planTier) throw new Error('Unsupported Stripe price ID');

    logStep('Checking billing admin permission', { user_id: user.id, organization_id: organizationId });

    const isBillingAdmin = await hasBillingAccess(supabaseClient, organizationId, user.id);

    if (!isBillingAdmin) {
      throw new Error('Not authorized: organization admin or billing admin role required');
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2025-08-27.basil' });

    const { data: orgBilling } = await supabaseClient
      .from('organization_billing')
      .select('stripe_customer_id')
      .eq('org_id', organizationId)
      .maybeSingle();

    let customerId = orgBilling?.stripe_customer_id || undefined;

    if (customerId) {
      logStep('Existing org Stripe customer found', { customerId, organizationId });
    } else {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          organization_id: organizationId,
          external_user_id: user.id,
        },
      });
      customerId = customer.id;

      await supabaseClient
        .from('organization_billing')
        .upsert({
          org_id: organizationId,
          stripe_customer_id: customerId,
          billing_email: user.email,
        }, { onConflict: 'org_id' });

      logStep('Created new org Stripe customer', { customerId, organizationId });
    }

    const origin = req.headers.get('origin') || 'http://localhost:3000';

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      client_reference_id: organizationId,
      metadata: {
        organization_id: organizationId,
        external_user_id: user.id,
        plan_tier: planTier,
      },
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      subscription_data: {
        metadata: {
          organization_id: organizationId,
          external_user_id: user.id,
          plan_tier: planTier,
        },
      },
      success_url: `${origin}/dashboard/organizations?billing_success=true`,
      cancel_url: `${origin}/dashboard/organizations?billing_canceled=true`,
    });

    logStep('Checkout session created', { sessionId: session.id, url: session.url });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep('ERROR', { message: errorMessage });
    const isAuthError = /authorization|authorized|authenticated|auth/i.test(errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: isAuthError ? 401 : 500,
    });
  }
});
