import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const toHttpError = (error: unknown) => {
  const err = error as { message?: string; code?: string; details?: string; hint?: string };
  const message = err?.message || 'Failed to create project';
  const code = err?.code;

  if (code === '22P02') {
    return { status: 400, message: 'Invalid UUID in request payload', code, details: err?.details, hint: err?.hint };
  }

  if (code === '23503') {
    return { status: 400, message: 'Invalid organization selected', code, details: err?.details, hint: err?.hint };
  }

  if (code === '42501') {
    return { status: 403, message: 'You do not have permission to create a project in this organization', code, details: err?.details, hint: err?.hint };
  }

  return { status: 500, message, code, details: err?.details, hint: err?.hint };
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const payload = await req.json().catch(() => ({}));
    const rawName = typeof payload?.name === 'string' ? payload.name : '';
    const userIdFromBody = typeof payload?.user_id === 'string' ? payload.user_id : '';
    const organizationId = typeof payload?.organization_id === 'string' && payload.organization_id.trim().length > 0
      ? payload.organization_id.trim()
      : null;

    const name = rawName.trim();
    if (!name) {
      return jsonResponse({ error: 'Missing required field: name' }, 400);
    }

    if (name.length > 120) {
      return jsonResponse({ error: 'Project name is too long (max 120 characters)' }, 400);
    }

    if (organizationId && !isUuid(organizationId)) {
      return jsonResponse({ error: 'organization_id must be a valid UUID' }, 400);
    }

    const externalSupabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authHeader = req.headers.get('Authorization') ?? '';

    if (!externalSupabaseUrl || !anonKey) {
      return jsonResponse({ error: 'Supabase credentials not configured' }, 500);
    }

    // Auth client: validates caller from JWT and can be used as DB client fallback.
    const authClient = createClient(externalSupabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    // Extract the raw JWT and pass it directly   getUser() without args uses the
    // stored session which is empty on a fresh client, causing spurious 401s.
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser(jwt);

    if (userError || !user) {
      return jsonResponse({ error: 'Not authenticated' }, 401);
    }

    if (userIdFromBody && userIdFromBody !== user.id) {
      return jsonResponse({ error: 'user_id does not match authenticated user' }, 403);
    }

    // Use service role when available, but keep auth fallback for environments
    // where service role is not configured.
    const dbClient = serviceRoleKey
      ? createClient(externalSupabaseUrl, serviceRoleKey)
      : authClient;

    if (organizationId && serviceRoleKey) {
      // Enforce org-level create access explicitly when using service role.
      // Allow: org creator, admin, billing_admin, member   all active org participants.
      const [{ data: ownedOrg, error: ownedOrgError }, { data: memberRow, error: memberError }] = await Promise.all([
        dbClient
          .from('organizations')
          .select('id')
          .eq('id', organizationId)
          .eq('created_by', user.id)
          .maybeSingle(),
        dbClient
          .from('org_members')
          .select('org_id, role')
          .eq('org_id', organizationId)
          .eq('user_id', user.id)
          .in('role', ['admin', 'billing_admin', 'member'])
          .maybeSingle(),
      ]);

      if (ownedOrgError) throw ownedOrgError;
      if (memberError) throw memberError;

      if (!ownedOrg && !memberRow) {
        return jsonResponse(
          { error: 'You do not have permission to create a project in this organization' },
          403,
        );
      }
    }

    const { data: project, error } = await dbClient
      .from('projects')
      .insert({
        name,
        user_id: user.id,
        created_by: user.id,
        organization_id: organizationId,
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return jsonResponse({ success: true, project });
  } catch (error) {
    console.error('Error in revision-create-project:', error);
    const mapped = toHttpError(error);
    return jsonResponse(
      {
        error: mapped.message,
        code: mapped.code,
        details: mapped.details,
        hint: mapped.hint,
      },
      mapped.status,
    );
  }
});
