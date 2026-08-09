import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Verify caller is super_admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError || !user) throw new Error("Not authenticated");

    const { data: roleData } = await supabaseClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "super_admin")
      .maybeSingle();
    if (!roleData) throw new Error("Not authorized — super_admin required");

    const { customer_email } = await req.json();
    if (!customer_email) throw new Error("customer_email is required");

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2023-10-16" });

    const customers = await stripe.customers.list({ email: customer_email, limit: 1 });
    if (customers.data.length === 0) {
      return new Response(JSON.stringify({ invoices: [], payment_method: null, subscription: null }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const customer = await stripe.customers.retrieve(customers.data[0].id, {
      expand: ["invoice_settings.default_payment_method"],
    }) as any;

    // Look for payment methods on file
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customer.id,
      type: "card",
      limit: 1,
    });

    let pmInfo: any = null;
    const defaultPm = customer.invoice_settings?.default_payment_method;
    const pm = defaultPm || paymentMethods.data[0];
    if (pm && typeof pm === "object" && pm.card) {
      pmInfo = {
        brand: pm.card.brand,
        last4: pm.card.last4,
        exp_month: pm.card.exp_month,
        exp_year: pm.card.exp_year,
        is_default: !!defaultPm,
      };
    }

    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 1,
    });
    const subInfo = subs.data[0]
      ? { id: subs.data[0].id, status: subs.data[0].status }
      : null;

    const invoices = await stripe.invoices.list({
      customer: customer.id,
      limit: 24,
    });

    const mapped = invoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amount_due: inv.amount_due,
      amount_paid: inv.amount_paid,
      currency: inv.currency,
      created: inv.created,
      period_start: inv.period_start,
      period_end: inv.period_end,
      hosted_invoice_url: inv.hosted_invoice_url,
      invoice_pdf: inv.invoice_pdf,
    }));

    return new Response(JSON.stringify({ invoices: mapped, payment_method: pmInfo, subscription: subInfo }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("List invoices admin error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
