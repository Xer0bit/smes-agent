import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { post_id, mcp_url } = await req.json();

    if (!post_id) {
      return new Response(
        JSON.stringify({ error: "post_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!mcp_url) {
      return new Response(
        JSON.stringify({ error: "mcp_url is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase admin client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Get the post to find external_post_id
    const { data: post, error: postError } = await supabase
      .from("social_media_posts")
      .select("id, external_post_id, platforms, account_id")
      .eq("id", post_id)
      .single();

    if (postError || !post) {
      return new Response(
        JSON.stringify({ error: "Post not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!post.external_post_id) {
      return new Response(
        JSON.stringify({ error: "No external post ID (LinkedIn URN) found. Stats can only be fetched for posts published through the app." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get the social account for org URN
    const { data: account } = await supabase
      .from("social_accounts")
      .select("page_config")
      .eq("id", post.account_id)
      .single();

    const orgUrn = account?.page_config?.organization_urn || "";

    // Call MCP proxy to fetch LinkedIn analytics
    const mcpProxyUrl = `${supabaseUrl}/functions/v1/mcp-proxy`;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Build the LinkedIn API URL for share statistics
    const linkedinApiUrl = orgUrn
      ? `/v2/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}&shares=${encodeURIComponent(post.external_post_id)}`
      : `/v2/shares/${encodeURIComponent(post.external_post_id)}`;

    const mcpRes = await fetch(mcpProxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
      },
      body: JSON.stringify({
        action: "invoke",
        mcp_url: mcp_url,
        tool_name: "linkedin_api_request_beta",
        tool_args: {
          method: "GET",
          url: `https://api.linkedin.com${linkedinApiUrl}`,
        },
      }),
    });

    const mcpData = await mcpRes.json();

    if (mcpData.error) {
      return new Response(
        JSON.stringify({ error: `MCP error: ${mcpData.error}` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse LinkedIn stats from MCP response
    // LinkedIn returns stats in different formats depending on endpoint
    const result = mcpData.result;
    let stats = {
      impressions: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      clicks: 0,
    };

    // Try to extract from organizationalEntityShareStatistics response
    try {
      const content = result?.content;
      let parsed = result;
      
      // If content is an array of text items (MCP format), parse the first text
      if (Array.isArray(content)) {
        const textItem = content.find((c: any) => c.type === "text");
        if (textItem?.text) {
          parsed = JSON.parse(textItem.text);
        }
      }

      // Navigate LinkedIn's response structure
      const elements = parsed?.elements || parsed?.results || [];
      if (elements.length > 0) {
        const el = elements[0];
        const totalStats = el?.totalShareStatistics || el;
        stats = {
          impressions: totalStats?.impressionCount || totalStats?.shareCount || 0,
          likes: totalStats?.likeCount || 0,
          comments: totalStats?.commentCount || 0,
          shares: totalStats?.shareCount || 0,
          clicks: totalStats?.clickCount || 0,
        };
      }
    } catch (parseErr) {
      console.error("Failed to parse LinkedIn stats:", parseErr);
    }

    // Upsert into post_analytics
    const { error: upsertError } = await supabase
      .from("post_analytics")
      .upsert(
        {
          post_id: post.id,
          platform: "linkedin",
          ...stats,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "post_id" }
      );

    if (upsertError) {
      console.error("Upsert error:", upsertError);
      return new Response(
        JSON.stringify({ error: `Failed to save analytics: ${upsertError.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, stats, raw: result }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("fetch-linkedin-analytics error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
