const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email, companyName } = await req.json();

    if (!email || !companyName) {
      return new Response(
        JSON.stringify({ error: "Email and company name are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Find or create customer
    const customers = await stripe.customers.list({ email, limit: 1 });
    let customer;
    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        name: companyName,
        metadata: { company_name: companyName },
      });
    }

    // Find or create the product
    const products = await stripe.products.list({ limit: 100 });
    let product = products.data.find((p) => p.metadata?.app_id === "ft30_media");
    if (!product) {
      product = await stripe.products.create({
        name: "FT30 Cross Border Media Platform",
        description: "Global press distribution, social media management & lead generation",
        metadata: { app_id: "ft30_media" },
      });
    }

    // Find or create recurring price: $699/mo
    const prices = await stripe.prices.list({ product: product.id, active: true, limit: 20 });
    let recurringPrice = prices.data.find(
      (p) => p.unit_amount === 69900 && p.recurring?.interval === "month"
    );
    if (!recurringPrice) {
      recurringPrice = await stripe.prices.create({
        product: product.id,
        unit_amount: 69900,
        currency: "usd",
        recurring: { interval: "month" },
      });
    }

    const origin = req.headers.get("origin") || "https://cross-media-launchpad.lovable.app";

    // Enforce one-time-per-account promo: only allow promo codes if this
    // customer has NEVER had a subscription before (new account only).
    const existingSubs = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 1,
    });
    const allowPromo = existingSubs.data.length === 0;

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        { price: recurringPrice.id, quantity: 1 },
      ],
      subscription_data: {
        metadata: {
          company_name: companyName,
          contract_months: "12",
        },
      },
      allow_promotion_codes: allowPromo,
      success_url: `${origin}/login?checkout=success`,
      cancel_url: `${origin}/?checkout=cancelled`,
    });

    return new Response(
      JSON.stringify({ url: session.url }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Checkout error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
