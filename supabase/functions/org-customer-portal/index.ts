import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { hasBillingAccess } from "../_shared/billing-access.ts";

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
  console.log(`[ORG-CUSTOMER-PORTAL] ${step}${detailsStr}`);
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
    const organizationId = body.organization_id || body.organizationId;

    if (!organizationId) throw new Error('organization_id required');

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

    if (!orgBilling?.stripe_customer_id) {
      throw new Error('No Stripe customer found for this organization');
    }

    const customerId = orgBilling.stripe_customer_id;
    logStep('Found Stripe customer', { customerId });

    const origin = req.headers.get('origin') || 'http://localhost:3000';

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/dashboard/organizations`,
    });

    logStep('Customer portal session created', { sessionId: portalSession.id, url: portalSession.url });

    return new Response(JSON.stringify({ url: portalSession.url }), {
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
