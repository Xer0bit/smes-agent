// Social accounts + posts. Buffer connect and publish go through
// ecg.portal() -- this gateway's own REST-to-MCP bridge to the Agent
// Portal -- using this project's OWN stored portal token (ecg.portal is
// only available when ECG_PORTAL_TOKEN is set, i.e. this dashboard was
// linked to an Agent Portal org at onboarding). The Buffer API key itself
// is stored in the Portal's org connector, never in this app's own tables.
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

async function assertClientAccess(clientId) {
  if (isAdmin) return true;
  const memberships = await db.select('client_users', { auth_user_id: authUser.id, client_id: clientId });
  return memberships.length > 0;
}

const action = params.action;

// ── Buffer connect (admin only, no clientId gate -- discovery doesn't touch a client row yet) ──
if (action === 'discoverBuffer') {
  if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403 });
  if (!ecg?.portal) return new Response(JSON.stringify({ error: 'This dashboard is not linked to an Agent Portal org.' }), { status: 400 });
  if (!params.apiKey) return new Response(JSON.stringify({ error: 'apiKey is required' }), { status: 400 });
  const result = await ecg.portal('POST', '/connectors/discover', { token: params.apiKey });
  return result; // { apps: string[] }
}

if (action === 'connectBuffer') {
  if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403 });
  if (!ecg?.portal) return new Response(JSON.stringify({ error: 'This dashboard is not linked to an Agent Portal org.' }), { status: 400 });
  const clientId = params.clientId;
  const platforms = params.platforms ?? [];
  if (!clientId || !params.apiKey || platforms.length === 0) {
    return new Response(JSON.stringify({ error: 'clientId, apiKey, and platforms are required' }), { status: 400 });
  }
  await ecg.portal('POST', '/connectors/org', { type: 'buffer', name: 'Buffer', apiKey: params.apiKey, platforms });
  const rows = platforms.map((platform) => ({ client_id: clientId, platform, account_name: `${platform} (Buffer)` }));
  return await db.insert('social_accounts', rows);
}

// ── Everything below is client-scoped ────────────────────────────────────────
const clientId = params.clientId;
if (!clientId) return new Response(JSON.stringify({ error: 'clientId is required' }), { status: 400 });
if (!(await assertClientAccess(clientId))) {
  return new Response(JSON.stringify({ error: 'No access to this client' }), { status: 403 });
}

if (action === 'listAccounts') {
  return await db.select('social_accounts', { client_id: clientId });
}

if (action === 'deleteAccount') {
  if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403 });
  await db.delete('social_accounts', { id: params.id, client_id: clientId });
  return { deleted: true };
}

if (action === 'listPosts') {
  return await db.select('social_media_posts', { client_id: clientId }, undefined, { created_at: { ascending: false } });
}

if (action === 'savePost') {
  const patch = { updated_at: new Date().toISOString() };
  for (const k of ['content', 'status', 'scheduledAt', 'mediaFileIds', 'platformData', 'accountId']) {
    if (params[k] === undefined) continue;
    const col = { scheduledAt: 'scheduled_at', mediaFileIds: 'media_file_ids', platformData: 'platform_data', accountId: 'account_id' }[k] ?? k;
    patch[col] = params[k];
  }
  if (params.platform) patch.platforms = [params.platform];

  if (params.id) {
    const rows = await db.update('social_media_posts', patch, { id: params.id });
    return rows[0];
  }
  const rows = await db.insert('social_media_posts', { ...patch, client_id: clientId, created_by: authUser.id });
  return rows[0];
}

if (action === 'deletePost') {
  await db.delete('social_media_posts', { id: params.id });
  return { deleted: true };
}

if (action === 'publishPost') {
  if (!ecg?.portal) return new Response(JSON.stringify({ error: 'This dashboard is not linked to an Agent Portal org.' }), { status: 400 });
  const posts = await db.select('social_media_posts', { id: params.id });
  if (posts.length === 0) return new Response(JSON.stringify({ error: 'Post not found' }), { status: 404 });
  const post = posts[0];
  const accounts = post.account_id ? await db.select('social_accounts', { id: post.account_id }) : [];
  const platform = accounts[0]?.platform ?? post.platforms?.[0];
  if (!platform) return new Response(JSON.stringify({ error: 'No platform set on this post' }), { status: 400 });

  const agents = await ecg.portal('GET', '/agents', undefined);
  const agentId = Array.isArray(agents) ? agents[0]?.id : agents?.agents?.[0]?.id;
  if (!agentId) return new Response(JSON.stringify({ error: 'No Agent Portal agent found to publish under.' }), { status: 400 });

  const created = await ecg.portal('POST', '/planned-posts', {
    agentId, content: post.content, platform, status: 'scheduled', scheduledAt: post.scheduled_at ?? undefined,
  });

  const rows = await db.update('social_media_posts', {
    status: 'published', published_at: new Date().toISOString(), external_post_id: created?.id ?? null,
  }, { id: params.id });
  return rows[0];
}

if (action === 'listAnalytics') {
  const postIds = params.postIds ?? [];
  if (postIds.length === 0) return [];
  return await db.select('post_analytics', undefined, `post_id=in.(${postIds.join(',')})`);
}

return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400 });
