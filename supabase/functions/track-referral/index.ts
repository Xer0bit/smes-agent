import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { referral_code, event_type, user_id } = await req.json();

    console.log('[track-referral] Processing:', { referral_code, event_type, user_id });

    if (!referral_code || !event_type || !user_id) {
      throw new Error('Missing required parameters');
    }

    // Find referral by code
    const { data: referral, error: fetchError } = await supabase
      .from('referrals')
      .select('*')
      .eq('referral_code', referral_code)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!referral) {
      console.log('[track-referral] Referral code not found');
      return new Response(
        JSON.stringify({ success: false, message: 'Invalid referral code' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if referrer has Agency subscription (no bonus for Agency users)
    const { data: orgMembers } = await supabase
      .from('org_members')
      .select('organizations!inner(plan_tier)')
      .eq('user_id', referral.referrer_user_id);

    const hasAgency = orgMembers?.some((om: any) => om.organizations?.plan_tier === 'agency');
    if (hasAgency) {
      console.log('[track-referral] Agency users do not earn referral bonuses');
      return new Response(
        JSON.stringify({ success: true, message: 'Agency users do not earn referral bonuses' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Find referrer's organization
    const { data: referrerOrg } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('user_id', referral.referrer_user_id)
      .maybeSingle();

    if (!referrerOrg) {
      console.log('[track-referral] Referrer has no organization');
      return new Response(
        JSON.stringify({ success: false, message: 'Referrer has no organization' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let updateData: any = {};
    let newStatus = referral.status;

    if (event_type === 'registered' && referral.status === 'pending') {
      updateData = {
        referred_user_id: user_id,
        status: 'registered',
        registered_at: new Date().toISOString(),
      };
      newStatus = 'registered';
    } else if (event_type === 'published' && referral.status === 'registered') {
      updateData = {
        status: 'published',
        published_at: new Date().toISOString(),
      };
      newStatus = 'published';
    }

    if (Object.keys(updateData).length > 0) {
      const { error: updateError } = await supabase
        .from('referrals')
        .update(updateData)
        .eq('id', referral.id);

      if (updateError) throw updateError;

      // If published, credit the bonus lines
      if (newStatus === 'published') {
        const { error: creditError } = await supabase
          .from('referrals')
          .update({
            status: 'credited',
            credited_at: new Date().toISOString(),
          })
          .eq('id', referral.id);

        if (creditError) throw creditError;

        // Add bonus lines to usage_tracking (by org_id)
        const now = new Date();
        const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

        const { data: usage } = await supabase
          .from('usage_tracking')
          .select('*')
          .eq('org_id', referrerOrg.org_id)
          .eq('period_start', periodStart)
          .maybeSingle();

        if (usage) {
          // Update existing record
          await supabase
            .from('usage_tracking')
            .update({
              bonus_lines: (usage.bonus_lines || 0) + 20,
            })
            .eq('id', usage.id);
        } else {
          // Create new record with bonus lines
          // Fetch org's plan_tier to determine lines_available
          const { data: orgData } = await supabase
            .from('organizations')
            .select('plan_tier')
            .eq('id', referrerOrg.org_id)
            .maybeSingle();

          const planTier = orgData?.plan_tier || 'free';
          let linesAvailable = 30; // Default for free
          if (planTier === 'pro') linesAvailable = 100;
          if (planTier === 'agency') linesAvailable = -1; // Unlimited

          await supabase
            .from('usage_tracking')
            .insert({
              org_id: referrerOrg.org_id,
              user_id: referral.referrer_user_id,
              period_start: periodStart,
              period_end: periodEnd,
              lines_used: 0,
              lines_available: linesAvailable,
              bonus_lines: 20,
            });
        }

        console.log('[track-referral] Credited 20 bonus lines to referrer organization');
      }
    }

    return new Response(
      JSON.stringify({ success: true, status: newStatus }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[track-referral] Error:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
