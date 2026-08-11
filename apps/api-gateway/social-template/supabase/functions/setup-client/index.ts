import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    // Get the calling user from the auth header
    const authHeader = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: userError } = await createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${authHeader}` } },
    }).auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid user" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { company_name } = await req.json();
    const name = company_name?.trim() || user.user_metadata?.full_name || user.email;

    // Check if user already has a client
    const { data: existing } = await adminClient
      .from("client_users")
      .select("client_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existing?.client_id) {
      return new Response(JSON.stringify({ client_id: existing.client_id, already_exists: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create client
    const { data: newClient, error: clientErr } = await adminClient
      .from("clients")
      .insert({ name })
      .select("id")
      .single();

    if (clientErr) throw clientErr;

    // Link user to client
    const { error: linkErr } = await adminClient
      .from("client_users")
      .insert({ client_id: newClient.id, user_id: user.id });

    if (linkErr) throw linkErr;

    // Ensure profile exists (safety net if trigger didn't fire)
    await adminClient
      .from("profiles")
      .upsert({
        id: user.id,
        email: user.email,
        full_name: user.user_metadata?.full_name || "",
      }, { onConflict: "id" });

    // Give user the admin role
    const { error: roleErr } = await adminClient
      .from("user_roles")
      .insert({ user_id: user.id, role: "admin" });

    // Ignore duplicate role errors
    if (roleErr && !roleErr.message?.includes("duplicate")) throw roleErr;

    return new Response(JSON.stringify({ client_id: newClient.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("setup-client error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
