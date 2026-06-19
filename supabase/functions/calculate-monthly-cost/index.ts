import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { hasBillingAccess } from "../_shared/billing-access.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CALCULATE-MONTHLY-COST] ${step}${detailsStr}`);
};

serve(async (req) => {
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

    // Get organization billing data
    const { data: orgBilling, error: billingError } = await supabaseClient
      .from('organization_billing')
      .select('plan_tier')
      .eq('org_id', organization_id)
      .single();

    if (billingError) throw new Error(`Billing error: ${billingError.message}`);

    const tier = orgBilling.plan_tier;
    logStep("Organization tier", { tier });

    // Get all projects for this organization
    const { data: projects, error: projectsError } = await supabaseClient
      .from('projects')
      .select('id, name')
      .eq('org_id', organization_id);

    if (projectsError) throw new Error(`Projects error: ${projectsError.message}`);

    logStep("Found projects", { count: projects?.length });

    let totalCost = 0;
    const breakdown: any[] = [];

    // Calculate cost for each project
    for (const project of projects || []) {
      const projectCosts: any = {
        project_id: project.id,
        project_name: project.name,
        add_ons: [],
        total: 0
      };

      // Get project add-ons
      const { data: addOns, error: addOnsError } = await supabaseClient
        .from('project_add_ons')
        .select(`
          quantity,
          add_on_id
        `)
        .eq('project_id', project.id)
        .eq('status', 'active');

      if (addOnsError) {
        logStep("Error fetching add-ons", { error: addOnsError });
        continue;
      }

      // Calculate add-on costs
      for (const projectAddOn of addOns || []) {
        // Fetch the add-on details
        const { data: addOnDetails } = await supabaseClient
          .from('add_ons')
          .select('name, price_amount, billing_type')
          .eq('id', projectAddOn.add_on_id)
          .single();

        if (!addOnDetails) continue;

        // Use single price_amount for all tiers
        const unitPrice = addOnDetails.price_amount;
        
        const cost = unitPrice * projectAddOn.quantity;
        projectCosts.add_ons.push({
          name: addOnDetails.name,
          quantity: projectAddOn.quantity,
          unit_price: unitPrice,
          cost: cost
        });
        projectCosts.total += cost;
      }

      breakdown.push(projectCosts);
      totalCost += projectCosts.total;
    }

    logStep("Cost calculation complete", { totalCost });

    return new Response(JSON.stringify({
      organization_id,
      subscription_tier: tier,
      total_monthly_cost: totalCost,
      projects: breakdown
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