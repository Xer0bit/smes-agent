// Generic file storage. This platform's hosted DB has no Supabase-Storage-
// style bucket, so small files (logos, brand assets, post images) are
// stored as base64 in app_files and served back as data: URLs. This has a
// real ceiling: base64 round-trips through JSON inside a 5-second function
// budget, so it's a fit for images/logos, NOT large video -- documented,
// not silently broken. Shared by brand-assets.js, social.js, and
// RichTextEditor's inline image uploads.
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

const action = params.action;

if (action === 'upload') {
  if (!params.dataBase64 || !params.fileName) {
    return new Response(JSON.stringify({ error: 'fileName and dataBase64 are required' }), { status: 400 });
  }
  // ~7MB base64 ~= 5MB raw -- comfortably inside a single request/response
  // round trip at this budget.
  if (params.dataBase64.length > 7_000_000) {
    return new Response(JSON.stringify({ error: 'File too large (5MB limit)' }), { status: 413 });
  }
  const rows = await db.insert('app_files', {
    client_id: params.clientId ?? null,
    file_name: params.fileName,
    mime_type: params.mimeType || 'application/octet-stream',
    data_base64: params.dataBase64,
    uploaded_by: authUser.id,
  });
  return { id: rows[0].id, fileName: rows[0].file_name };
}

if (action === 'get') {
  if (!params.fileId) return new Response(JSON.stringify({ error: 'fileId is required' }), { status: 400 });
  const rows = await db.select('app_files', { id: params.fileId });
  if (rows.length === 0) return new Response(JSON.stringify({ error: 'File not found' }), { status: 404 });
  const file = rows[0];
  return { dataUrl: `data:${file.mime_type};base64,${file.data_base64}`, fileName: file.file_name };
}

if (action === 'delete') {
  if (!params.fileId) return new Response(JSON.stringify({ error: 'fileId is required' }), { status: 400 });
  await db.delete('app_files', { id: params.fileId });
  return { deleted: true };
}

return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400 });
