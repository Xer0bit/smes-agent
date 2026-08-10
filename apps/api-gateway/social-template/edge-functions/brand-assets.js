// Brand asset rows (logo, guidelines, etc). File bytes live in app_files
// (see files.js) -- this function only manages the brand_assets rows that
// point at them, mirroring the original app's revision-tracked upload flow
// (a new upload for the same asset_type bumps `revision` and replaces the
// row rather than accumulating duplicates).
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
const clientId = params.clientId;
if (!clientId) return new Response(JSON.stringify({ error: 'clientId is required' }), { status: 400 });
if (!(await assertClientAccess(clientId))) {
  return new Response(JSON.stringify({ error: 'No access to this client' }), { status: 403 });
}

if (action === 'list') {
  return await db.select('brand_assets', { client_id: clientId }, undefined, { asset_type: { ascending: true } });
}

// fileId must already exist (uploaded via files.js action:'upload' first).
if (action === 'save') {
  if (!params.assetType || !params.fileId || !params.fileName) {
    return new Response(JSON.stringify({ error: 'assetType, fileId, and fileName are required' }), { status: 400 });
  }
  const existing = await db.select('brand_assets', { client_id: clientId, asset_type: params.assetType });
  if (existing.length > 0) {
    const oldFileId = existing[0].file_id;
    const rows = await db.update('brand_assets', {
      file_id: params.fileId, file_name: params.fileName, description: params.description ?? null,
      revision: (existing[0].revision ?? 1) + 1, uploaded_by: authUser.id, updated_at: new Date().toISOString(),
    }, { id: existing[0].id });
    // Clean up the superseded blob -- otherwise every re-upload leaves a
    // dead app_files row behind (base64 content, not trivial size).
    if (oldFileId && oldFileId !== params.fileId) {
      try { await db.delete('app_files', { id: oldFileId }); } catch { /* non-fatal cleanup */ }
    }
    return rows[0];
  }
  const rows = await db.insert('brand_assets', {
    client_id: clientId, asset_type: params.assetType, file_id: params.fileId, file_name: params.fileName,
    description: params.description ?? null, uploaded_by: authUser.id,
  });
  return rows[0];
}

if (action === 'delete') {
  if (!params.id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400 });
  const existing = await db.select('brand_assets', { id: params.id });
  await db.delete('brand_assets', { id: params.id });
  if (existing[0]?.file_id) {
    try { await db.delete('app_files', { id: existing[0].file_id }); } catch { /* non-fatal cleanup */ }
  }
  return { deleted: true };
}

return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400 });
