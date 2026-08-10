// Client (agency customer) CRUD + client-portal membership. Admin only --
// members never manage clients or other members, matching the original
// app's isSuperAdmin-gated UI.
async function verifyCaller() {
  if (!params.accessToken || !params.authUrl) return null;
  const res = await fetch(`${params.authUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${params.accessToken}`, apikey: params.authAnonKey },
  });
  if (!res.ok) return null;
  return await res.json();
}

const authUser = await verifyCaller();
if (!authUser) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

const roles = await db.select('user_roles', { auth_user_id: authUser.id });
const isAdmin = roles.some((r) => r.role === 'admin');
if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403 });

const action = params.action;

if (action === 'list') {
  return await db.select('clients', undefined, undefined, { name: { ascending: true } });
}

if (action === 'get') {
  if (!params.id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400 });
  const rows = await db.select('clients', { id: params.id });
  if (rows.length === 0) return new Response(JSON.stringify({ error: 'Client not found' }), { status: 404 });
  return rows[0];
}

if (action === 'create') {
  if (!params.name) return new Response(JSON.stringify({ error: 'name is required' }), { status: 400 });
  const rows = await db.insert('clients', { name: params.name, status: params.status || 'active' });
  return rows[0];
}

if (action === 'update') {
  if (!params.id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400 });
  const patch = {};
  if (params.name !== undefined) patch.name = params.name;
  if (params.status !== undefined) patch.status = params.status;
  const rows = await db.update('clients', patch, { id: params.id });
  return rows[0];
}

if (action === 'delete') {
  if (!params.id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400 });
  await db.delete('clients', { id: params.id });
  return { deleted: true };
}

if (action === 'listMembers') {
  if (!params.clientId) return new Response(JSON.stringify({ error: 'clientId is required' }), { status: 400 });
  const members = await db.select('client_users', { client_id: params.clientId });
  const claimedIds = members.filter((m) => m.auth_user_id).map((m) => m.auth_user_id);
  const profiles = claimedIds.length > 0
    ? await db.select('profiles', ['auth_user_id', 'email', 'full_name'], `auth_user_id=in.(${claimedIds.join(',')})`)
    : [];
  const byId = Object.fromEntries(profiles.map((p) => [p.auth_user_id, p]));
  return members.map((m) => ({
    id: m.id,
    status: m.auth_user_id ? 'active' : 'invited',
    email: m.auth_user_id ? byId[m.auth_user_id]?.email : m.invited_email,
    fullName: m.auth_user_id ? byId[m.auth_user_id]?.full_name : null,
  }));
}

// Grants portal access to `email` for `clientId`. If that email hasn't
// signed up yet, the invite is claimed automatically on their first login
// (see auth-context.js) -- there is no server-side way to create a
// password-set account directly (no admin API for cloud auth is exposed to
// edge functions), so invite-then-self-signup is the only path.
if (action === 'inviteMember') {
  if (!params.clientId || !params.email) {
    return new Response(JSON.stringify({ error: 'clientId and email are required' }), { status: 400 });
  }
  const email = params.email.toLowerCase().trim();
  const existingProfile = await db.select('profiles', { email });
  const rows = await db.insert('client_users', existingProfile.length > 0
    ? { client_id: params.clientId, auth_user_id: existingProfile[0].auth_user_id }
    : { client_id: params.clientId, invited_email: email });
  return rows[0];
}

if (action === 'removeMember') {
  if (!params.id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400 });
  await db.delete('client_users', { id: params.id });
  return { deleted: true };
}

return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400 });
