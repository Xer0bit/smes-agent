// Client-scoped content: leads, lead forms (+ published-Google-Sheet sync),
// press releases + their tracked URLs, and the Dashboard's summary counts.
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

// ── Lead forms + leads ───────────────────────────────────────────────────────
if (action === 'listLeadForms') {
  return await db.select('lead_forms', { client_id: clientId });
}
if (action === 'createLeadForm') {
  const rows = await db.insert('lead_forms', {
    client_id: clientId, form_name: params.formName, webhook_url: params.webhookUrl ?? null,
  });
  return rows[0];
}
if (action === 'updateLeadForm') {
  const patch = {};
  if (params.formName !== undefined) patch.form_name = params.formName;
  if (params.webhookUrl !== undefined) patch.webhook_url = params.webhookUrl;
  const rows = await db.update('lead_forms', patch, { id: params.id });
  return rows[0];
}
if (action === 'deleteLeadForm') {
  await db.delete('lead_forms', { id: params.id });
  return { deleted: true };
}
if (action === 'listLeads') {
  return await db.select('leads', { client_id: clientId });
}

// Reads a published-to-web Google Sheet (CSV export, no OAuth) -- config
// lives in lead_forms.webhook_url as JSON {sheet_url, col_start, col_end},
// same convention the original app used.
if (action === 'syncGoogleSheet') {
  const sheetId = params.sheetId;
  const colStart = params.colStart || 'A';
  const colEnd = params.colEnd || 'F';
  if (!sheetId) return new Response(JSON.stringify({ error: 'sheetId is required' }), { status: 400 });
  const range = `${colStart}:${colEnd}`;
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&range=${range}`);
  if (!res.ok) return new Response(JSON.stringify({ error: 'Could not read that sheet -- is it published to the web?' }), { status: 502 });
  const csv = await res.text();
  const lines = csv.split('\n').map((l) => l.trim()).filter(Boolean);
  const parseCsvLine = (line) => line.match(/(".*?"|[^,]+)(?=\s*,|\s*$)/g)?.map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"')) ?? [];
  const headers = lines[0] ? parseCsvLine(lines[0]) : [];
  const rows = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
  });
  return { headers, rows };
}

// ── Press releases ───────────────────────────────────────────────────────────
if (action === 'listPressReleases') {
  return await db.select('press_releases', { client_id: clientId }, undefined, { created_at: { ascending: false } });
}
if (action === 'listPressReleaseUrls') {
  const releaseIds = params.releaseIds ?? [];
  if (releaseIds.length === 0) return [];
  return await db.select('press_release_urls', undefined, `press_release_id=in.(${releaseIds.join(',')})`);
}
if (action === 'createPressRelease') {
  const rows = await db.insert('press_releases', {
    client_id: clientId, title: params.title, content: params.content ?? '', created_by: authUser.id,
  });
  return rows[0];
}
if (action === 'updatePressRelease') {
  const patch = { updated_at: new Date().toISOString() };
  const fields = { title: 'title', content: 'content', status: 'status', adminComment: 'admin_comment', publishedUrl: 'published_url' };
  for (const [k, col] of Object.entries(fields)) {
    if (params[k] !== undefined) patch[col] = params[k];
  }
  const rows = await db.update('press_releases', patch, { id: params.id });
  return rows[0];
}
if (action === 'submitPressRelease') {
  const rows = await db.update('press_releases', { status: 'submitted', updated_at: new Date().toISOString() }, { id: params.id });
  return rows[0];
}
if (action === 'deletePressRelease') {
  await db.delete('press_releases', { id: params.id });
  return { deleted: true };
}
if (action === 'addPressReleaseUrls') {
  const rows = (params.urls ?? []).map((u) => ({
    press_release_id: params.pressReleaseId, url: u.url, outlet_name: u.outletName ?? null,
    unique_visits: u.uniqueVisits ?? 0, total_visits: u.totalVisits ?? 0,
  }));
  if (rows.length === 0) return [];
  return await db.insert('press_release_urls', rows);
}
if (action === 'deletePressReleaseUrls') {
  const ids = params.ids ?? [];
  if (ids.length === 0) return { deleted: true };
  await db.delete('press_release_urls', `id=in.(${ids.join(',')})`);
  return { deleted: true };
}

// ── Dashboard summary ────────────────────────────────────────────────────────
if (action === 'summary') {
  const [pressReleases, socialPosts, leads, leadForms] = await Promise.all([
    db.select('press_releases', { client_id: clientId }, undefined, { created_at: { ascending: false } }),
    db.select('social_media_posts', { client_id: clientId }, undefined, { created_at: { ascending: false } }),
    db.select('leads', { client_id: clientId }),
    db.select('lead_forms', { client_id: clientId }),
  ]);
  return { pressReleases, socialPosts, leads, leadForms };
}

return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400 });
