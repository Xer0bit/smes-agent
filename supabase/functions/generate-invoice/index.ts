import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { hasBillingAccess } from "../_shared/billing-access.ts";

const ALLOWED_ORIGINS = [
  'https://SMEsAgent.app', 'https://www.SMEsAgent.app',
  'https://SMEsAgent.dev', 'https://www.SMEsAgent.dev', 'https://1000.SMEsAgent.dev',
  'http://localhost:8080', 'http://localhost:3000',
];
const getCorsHeaders = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Credentials': 'true',
});

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[GENERATE-INVOICE] ${step}${detailsStr}`);
};

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY not set");

    const supabaseClient = createClient(
      Deno.env.get("EXTERNAL_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("EXTERNAL_SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Auth error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");

    const { organization_id } = await req.json();
    if (!organization_id) throw new Error("organization_id required");

    logStep("Checking billing admin permission", { user_id: user.id, organization_id });

    const isBillingAdmin = await hasBillingAccess(supabaseClient, organization_id, user.id);

    if (!isBillingAdmin) {
      throw new Error("Not authorized: organization admin or billing admin role required");
    }

    logStep("Fetching organization billing data");

    // Get organization and billing data
    const { data: orgBilling, error: billingError } = await supabaseClient
      .from('organization_billing')
      .select('subscription_tier, stripe_customer_id')
      .eq('organization_id', organization_id)
      .single();

    if (billingError) throw new Error(`Billing error: ${billingError.message}`);

    // Get organization details
    const { data: org, error: orgError } = await supabaseClient
      .from('organizations')
      .select('name, created_by')
      .eq('id', organization_id)
      .single();

    if (orgError) throw new Error(`Organization error: ${orgError.message}`);

    const tier = orgBilling.subscription_tier;
    let stripeCustomerId = orgBilling.stripe_customer_id;

    logStep("Organization data", { tier, has_customer: !!stripeCustomerId });

    // Initialize Stripe
    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Create Stripe customer if doesn't exist
    if (!stripeCustomerId) {
      logStep("Creating Stripe customer");
      
      // Get org creator's email
      const { data: creatorProfile } = await supabaseClient
        .from('profiles')
        .select('email')
        .eq('id', org.created_by)
        .single();

      const customer = await stripe.customers.create({
        email: creatorProfile?.email || user.email,
        name: org.name,
        metadata: {
          organization_id: organization_id
        }
      });

      stripeCustomerId = customer.id;

      // Update organization_billing with stripe_customer_id
      await supabaseClient
        .from('organization_billing')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('organization_id', organization_id);

      logStep("Stripe customer created", { customer_id: stripeCustomerId });
    }

    // Calculate monthly costs
    logStep("Calculating costs");
    
    const { data: projects } = await supabaseClient
      .from('projects')
      .select('id, name')
      .eq('organization_id', organization_id);

    let totalAmount = 0;
    const lineItems: any[] = [];

    // Calculate cost for each project
    for (const project of projects || []) {
      const { data: addOns } = await supabaseClient
        .from('project_add_ons')
        .select('quantity, addon_id')
        .eq('project_id', project.id)
        .eq('is_active', true);

      for (const projectAddOn of addOns || []) {
        // Fetch add-on details
        const { data: addOnDetails } = await supabaseClient
          .from('add_ons')
          .select('addon_name, unit_price_pro, unit_price_agency, billing_type')
          .eq('id', projectAddOn.addon_id)
          .single();

        if (!addOnDetails) continue;

        const unitPrice = tier === 'agency' 
          ? addOnDetails.unit_price_agency 
          : addOnDetails.unit_price_pro;
        
        const cost = unitPrice * projectAddOn.quantity;
        totalAmount += cost;

        lineItems.push({
          project_name: project.name,
          addon_name: addOnDetails.addon_name,
          quantity: projectAddOn.quantity,
          unit_price: unitPrice,
          total: cost
        });
      }
    }

    logStep("Total amount calculated", { amount: totalAmount });

    if (totalAmount === 0) {
      throw new Error("No charges for this billing period");
    }

    // Create invoice in database
    const { data: invoice, error: invoiceError } = await supabaseClient
      .from('invoices')
      .insert({
        organization_id: organization_id,
        amount: totalAmount,
        status: 'pending',
        billing_period_start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
        billing_period_end: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString(),
        line_items: lineItems
      })
      .select()
      .single();

    if (invoiceError) throw new Error(`Invoice creation error: ${invoiceError.message}`);

    logStep("Invoice created in database", { invoice_id: invoice.id });

    // Create Stripe invoice
    const stripeInvoice = await stripe.invoices.create({
      customer: stripeCustomerId,
      auto_advance: true,
      collection_method: 'charge_automatically',
      description: `Monthly billing for ${org.name}`,
      metadata: {
        organization_id: organization_id,
        internal_invoice_id: invoice.id
      }
    });

    // Add invoice items
    for (const item of lineItems) {
      await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        invoice: stripeInvoice.id,
        amount: Math.round(item.total * 100), // Convert to cents
        currency: 'usd',
        description: `${item.project_name} - ${item.addon_name} (${item.quantity} units)`
      });
    }

    // Finalize and charge the invoice
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(stripeInvoice.id);
    const paidInvoice = await stripe.invoices.pay(finalizedInvoice.id);

    logStep("Stripe invoice created and charged", { 
      stripe_invoice_id: paidInvoice.id,
      status: paidInvoice.status 
    });

    // Update database invoice with Stripe ID and status
    await supabaseClient
      .from('invoices')
      .update({
        stripe_invoice_id: paidInvoice.id,
        status: paidInvoice.status === 'paid' ? 'paid' : 'pending',
        paid_at: paidInvoice.status === 'paid' ? new Date().toISOString() : null
      })
      .eq('id', invoice.id);

    return new Response(JSON.stringify({
      success: true,
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      stripe_invoice_id: paidInvoice.id,
      amount: totalAmount,
      status: paidInvoice.status,
      hosted_invoice_url: paidInvoice.hosted_invoice_url
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});