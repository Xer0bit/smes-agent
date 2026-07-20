import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const body = await req.json().catch(() => null);
        const { user_id, organization_name, project_name, guest_project_id } = body ?? {};

        if (!user_id || !organization_name || !project_name) {
            return jsonResponse({ success: false, error: 'Missing required fields: user_id, organization_name, project_name' }, 400);
        }

        if (typeof user_id !== 'string' || !UUID_V4_REGEX.test(user_id)) {
            return jsonResponse({ success: false, error: 'Invalid user_id: expected a valid UUID' }, 400);
        }

        if (typeof organization_name !== 'string' || organization_name.trim().length < 2 || organization_name.trim().length > 100) {
            return jsonResponse({ success: false, error: 'Invalid organization_name: expected 2-100 characters' }, 400);
        }

        if (typeof project_name !== 'string' || project_name.trim().length < 2 || project_name.trim().length > 100) {
            return jsonResponse({ success: false, error: 'Invalid project_name: expected 2-100 characters' }, 400);
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

        if (!supabaseUrl || !supabaseKey) {
            throw new Error('Supabase credentials not configured in environment');
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        // ── Idempotency guard ─────────────────────────────────────────────────
        // Check ANY org membership (not just 'admin')   the fallback path in
        // AuthCallback.tsx creates rows with role='owner', which the old
        // .eq('role','admin') check would miss, causing a new org on every login.
        const { data: existingMember } = await supabase
            .from('org_members')
            .select('org_id')
            .eq('user_id', user_id)
            .limit(1)
            .maybeSingle();

        // Second guard: also check organizations.created_by in case org_members
        // row was somehow deleted but the org still exists.
        const { data: existingOrg } = existingMember ? { data: null } : await supabase
            .from('organizations')
            .select('id')
            .eq('created_by', user_id)
            .limit(1)
            .maybeSingle();

        const alreadySetUp = existingMember ?? existingOrg;

        if (alreadySetUp) {
            const resolvedOrgId = existingMember?.org_id ?? existingOrg?.id;
            const { data: existingProject } = await supabase
                .from('projects')
                .select('id')
                .eq('user_id', user_id)
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle();

            console.log('Signup already complete for user:', user_id, '  skipping org creation');
            return jsonResponse({
                    success: true,
                    organization_id: resolvedOrgId,
                    project_id: existingProject?.id ?? null,
                });
        }

        // ── Step 0: Create profile (no DB trigger does this automatically) ────
        const { data: { user: callerUser } } = await supabase.auth.admin.getUserById(user_id);
        await supabase
            .from('profiles')
            .upsert(
                {
                    id: user_id,
                    email: callerUser?.email ?? '',
                    full_name: callerUser?.user_metadata?.full_name ?? '',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'id', ignoreDuplicates: true }
            );

        // ── Generate slug from organization name ──────────────────────────────
        const generateSlug = (name: string): string => {
            const baseSlug = name
                .toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[^a-z0-9-]/g, '')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '');
            const suffix = Math.random().toString(36).substring(2, 8);
            return `${baseSlug}-${suffix}`;
        };

        const slug = generateSlug(organization_name);

        // ── Step 1: Create organization ───────────────────────────────────────
        const { data: organization, error: orgError } = await supabase
            .from('organizations')
            .insert({
                name: organization_name,
                slug: slug,
                created_by: user_id,
            })
            .select()
            .single();

        if (orgError) {
            console.error('Error creating organization:', orgError);
            throw new Error(`Failed to create organization: ${orgError.message}`);
        }

        // ── Step 2: Add user as admin to org_members ────────────────────────
        // org_members does not have a UNIQUE(org_id, user_id) constraint in this
        // schema, so upsert(onConflict: 'org_id,user_id') throws 42P10.
        const { data: existingOrgMember, error: existingMemberError } = await supabase
            .from('org_members')
            .select('id')
            .eq('org_id', organization.id)
            .eq('user_id', user_id)
            .maybeSingle();

        if (existingMemberError) {
            console.error('Error checking org member:', existingMemberError);
            throw new Error(`Failed to check organization membership: ${existingMemberError.message}`);
        }

        if (!existingOrgMember) {
            const { error: memberInsertError } = await supabase
                .from('org_members')
                .insert({ org_id: organization.id, user_id: user_id, role: 'admin' });

            if (memberInsertError) {
                console.error('Error adding org member:', memberInsertError);
                throw new Error(`Failed to add organization member: ${memberInsertError.message}`);
            }
        }

        // ── Step 3: Create project linked to organization ─────────────────────
        const { data: project, error: projectError } = await supabase
            .from('projects')
            .insert({
                name: project_name,
                user_id: user_id,
                created_by: user_id,
                organization_id: organization.id,
            })
            .select()
            .single();

        if (projectError) {
            console.error('Error creating project:', projectError);
            throw new Error(`Failed to create project: ${projectError.message}`);
        }

        console.log('Signup complete:', {
            organization_id: organization.id,
            project_id: project.id,
            guest_project_id,
        });

        return new Response(
            JSON.stringify({
                success: true,
                organization_id: organization.id,
                project_id: project.id,
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        console.error('Error in signup-complete:', error);
        return new Response(
            JSON.stringify({ error: (error as Error).message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
