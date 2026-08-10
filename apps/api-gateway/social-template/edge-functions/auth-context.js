// Bootstraps and returns the caller's identity + role + client memberships.
// Called once by the frontend right after a cloud-auth session exists
// (src/contexts/AuthzContext.tsx). This is the ONLY function that writes to
// `profiles` -- every other function only READS it to check who's calling.
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

const email = (authUser.email || '').toLowerCase();
const fullName = authUser.user_metadata?.full_name || null;

// Upsert profile. db.insert has no native upsert -- select first, branch.
const existing = await db.select('profiles', { auth_user_id: authUser.id });
if (existing.length === 0) {
  await db.insert('profiles', { auth_user_id: authUser.id, email, full_name: fullName });
} else if (existing[0].email !== email) {
  await db.update('profiles', { email, updated_at: new Date().toISOString() }, { auth_user_id: authUser.id });
}

// Claim any pending client invites addressed to this email.
const pendingInvites = await db.select('client_users', { invited_email: email });
for (const invite of pendingInvites) {
  await db.update(
    'client_users',
    { auth_user_id: authUser.id, invited_email: null },
    { id: invite.id },
  );
}

// Bootstrap: the very first user this tenant ever sees becomes admin.
let roles = await db.select('user_roles', { auth_user_id: authUser.id });
const anyRoleExists = await db.count('user_roles');
if (roles.length === 0 && (anyRoleExists.count ?? 0) === 0) {
  await db.insert('user_roles', { auth_user_id: authUser.id, role: 'admin' });
  roles = [{ role: 'admin' }];
}
const isAdmin = roles.some((r) => r.role === 'admin');

const memberships = await db.select('client_users', { auth_user_id: authUser.id });
const clientIds = memberships.map((m) => m.client_id);

let clients = [];
if (isAdmin) {
  clients = await db.select('clients', ['id', 'name', 'status'], undefined, { name: { ascending: true } });
} else if (clientIds.length > 0) {
  clients = await db.select('clients', ['id', 'name', 'status'], `id=in.(${clientIds.join(',')})`);
}

return { authUserId: authUser.id, email, fullName, isAdmin, clientIds, clients };
