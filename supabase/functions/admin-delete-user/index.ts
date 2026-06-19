import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

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
        const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const adminClient = createClient(supabaseUrl, serviceKey, {
            auth: { autoRefreshToken: false, persistSession: false },
        });

        // ── Verify caller is an admin / super_admin ──────────────────────────
        const authHeader = req.headers.get('Authorization') ?? '';
        const token = authHeader.replace('Bearer ', '');
        const { data: { user: caller }, error: authErr } = await adminClient.auth.getUser(token);
        if (authErr || !caller) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const { data: roleRow } = await adminClient
            .from('user_roles')
            .select('role')
            .eq('user_id', caller.id)
            .in('role', ['admin', 'super_admin'])
            .maybeSingle();

        if (!roleRow) {
            return new Response(JSON.stringify({ error: 'Forbidden – admin only' }), {
                status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // ── Get user_id to delete ────────────────────────────────────────────
        const { user_id } = await req.json();
        if (!user_id) {
            return new Response(JSON.stringify({ error: 'Missing user_id' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Prevent deleting the built-in super_admin
        if (user_id === 'a0000000-0000-0000-0000-000000000001') {
            return new Response(JSON.stringify({ error: 'Cannot delete the built-in super admin' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const { error: cleanupErr } = await adminClient.rpc('prepare_user_delete', {
            p_user_id: user_id,
        });

        if (cleanupErr) {
            console.error('Prepare user delete error:', cleanupErr);
            return new Response(JSON.stringify({ error: cleanupErr.message }), {
                status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // ── Delete from auth.users after public-schema references are cleared ──
        const { error: deleteErr } = await adminClient.auth.admin.deleteUser(user_id);
        if (deleteErr) {
            console.error('Delete user error:', deleteErr);
            return new Response(JSON.stringify({ error: deleteErr.message }), {
                status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    } catch (err) {
        console.error('admin-delete-user error:', err);
        return new Response(JSON.stringify({ error: (err as Error).message }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
