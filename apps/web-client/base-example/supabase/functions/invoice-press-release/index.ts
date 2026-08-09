import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Additional Press Release: $199 one-time
const PRESS_RELEASE_PRICE_ID = "price_1TKr110Yjsz0mrd7AO299WXB";

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

    const { customer_email, quantity, description } = await req.json();
    if (!customer_email) throw new Error("customer_email is required");

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2023-10-16" });

    // Find customer
    const customers = await stripe.customers.list({ email: customer_email, limit: 1 });
    if (customers.data.length === 0) {
      throw new Error(`No Stripe customer found for ${customer_email}`);
    }
    const customerId = customers.data[0].id;

    // Create invoice
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: "send_invoice",
      days_until_due: 30,
      description: description || "Additional Press Release(s)",
    });

    // Add line items
    const qty = quantity || 1;
    await stripe.invoiceItems.create({
      customer: customerId,
      price: PRESS_RELEASE_PRICE_ID,
      quantity: qty,
      invoice: invoice.id,
    });

    // Finalize and send
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

    return new Response(JSON.stringify({
      invoice_id: finalizedInvoice.id,
      invoice_number: finalizedInvoice.number,
      amount_due: finalizedInvoice.amount_due,
      hosted_invoice_url: finalizedInvoice.hosted_invoice_url,
      status: finalizedInvoice.status,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Invoice press release error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
