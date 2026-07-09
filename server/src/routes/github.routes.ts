/**
 * GitHub connector — connect a GitHub account (OAuth), link a repo per project,
 * and push the project's current files to that repo as a single commit.
 */
import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac } from 'node:crypto';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { supabase, supabaseAuth } from '../config/database.js';
import { projectService } from '../services/project.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const SERVER_URL = (process.env.ECOMGEAR_SERVER_URL || 'https://api.ecomgear.dev').replace(/\/$/, '');
const APP_URL    = (process.env.APP_URL || 'https://www.ecomgear.dev').replace(/\/$/, '');
// Must exactly match the "Authorization callback URL" registered on the
// GitHub OAuth App — that's /auth/github/callback, not /api/v1/github/callback.
const REDIRECT_URI = `${SERVER_URL}/auth/github/callback`;
// Reuses the tenant-DB HMAC secret purely as a signing key for this short-lived
// OAuth state token — no relation to tenant DB auth, just an existing secret.
const STATE_SECRET = process.env.TENANT_DB_JWT_SECRET || process.env.SUPABASE_JWT_SECRET || '';

function resolveProjectPath(projectId: string, serverPath?: string): string {
  if (serverPath) return serverPath;
  if (process.env.SERVER_PROJECTS_DIR) return path.join(process.env.SERVER_PROJECTS_DIR, projectId);
  if (process.env.NODE_ENV === 'production') return path.join('/var/ecomgear/projects', projectId);
  const localBase = process.env.LOCAL_PREVIEW_DATA || path.join(os.homedir(), '.ecomgear', 'preview');
  return path.join(localBase, projectId);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signState(payload: { uid: string; exp: number }): string {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', STATE_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function verifyState(state: string): { uid: string } | null {
  try {
    const [body, sig] = state.split('.');
    if (!body || !sig) return null;
    const expected = b64url(createHmac('sha256', STATE_SECRET).update(body).digest());
    if (sig !== expected) return null;
    const payload = JSON.parse(fromB64url(body).toString('utf8')) as { uid: string; exp: number };
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.uid !== 'string') return null;
    return { uid: payload.uid };
  } catch {
    return null;
  }
}

async function getConnection(userId: string) {
  const { data } = await supabase
    .from('github_connections')
    .select('access_token, github_login, avatar_url')
    .eq('user_id', userId)
    .maybeSingle();
  return data as { access_token: string; github_login: string; avatar_url: string | null } | null;
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// ── GET /api/v1/github/connect?token=<supabase_access_token> ─────────────────
// A top-level browser redirect, so it can't carry an Authorization header —
// the frontend passes the session token as a query param instead.
router.get('/connect', async (req: Request, res: Response) => {
  const token = req.query.token as string | undefined;
  if (!token) { res.status(401).send('Missing token'); return; }
  if (!GITHUB_CLIENT_ID) { res.status(500).send('GitHub integration is not configured on this server.'); return; }

  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data.user) { res.status(401).send('Invalid session'); return; }

  const state = signState({ uid: data.user.id, exp: Math.floor(Date.now() / 1000) + 600 });
  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('scope', 'repo read:user');
  authorizeUrl.searchParams.set('state', state);
  res.redirect(authorizeUrl.toString());
});

// ── GET /api/v1/github/callback ───────────────────────────────────────────────
router.get('/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const settingsUrl = `${APP_URL}/dashboard/settings?section=project-integrations`;

  const verified = state ? verifyState(state) : null;
  if (!code || !verified) {
    res.redirect(`${settingsUrl}&github=error`);
    return;
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokenJson = await tokenRes.json() as { access_token?: string; scope?: string; error?: string };
    if (!tokenJson.access_token) {
      logger.warn('[GitHub OAuth] token exchange failed', { error: tokenJson.error });
      res.redirect(`${settingsUrl}&github=error`);
      return;
    }

    const userRes = await fetch('https://api.github.com/user', { headers: ghHeaders(tokenJson.access_token) });
    const ghUser = await userRes.json() as { id: number; login: string; avatar_url: string };
    if (!userRes.ok || !ghUser.id) {
      res.redirect(`${settingsUrl}&github=error`);
      return;
    }

    await supabase.from('github_connections').upsert(
      {
        user_id: verified.uid,
        github_user_id: ghUser.id,
        github_login: ghUser.login,
        avatar_url: ghUser.avatar_url,
        access_token: tokenJson.access_token,
        scope: tokenJson.scope ?? null,
        connected_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );

    res.redirect(`${settingsUrl}&github=connected`);
  } catch (err) {
    logger.error('[GitHub OAuth] callback error', err);
    res.redirect(`${settingsUrl}&github=error`);
  }
});

// ── GET /api/v1/github/status ──────────────────────────────────────────────
router.get('/status', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const conn = await getConnection(req.user!.id);
  res.json(conn
    ? { connected: true, login: conn.github_login, avatarUrl: conn.avatar_url }
    : { connected: false });
});

// ── DELETE /api/v1/github/disconnect ───────────────────────────────────────
router.delete('/disconnect', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const conn = await getConnection(req.user!.id);
  if (conn && GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET) {
    // Best-effort revoke on GitHub's side too — non-fatal if it fails.
    fetch(`https://api.github.com/applications/${GITHUB_CLIENT_ID}/grant`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${Buffer.from(`${GITHUB_CLIENT_ID}:${GITHUB_CLIENT_SECRET}`).toString('base64')}`,
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({ access_token: conn.access_token }),
    }).catch(() => {});
  }
  await supabase.from('github_connections').delete().eq('user_id', req.user!.id);
  res.json({ success: true });
});

// ── GET /api/v1/github/repos ────────────────────────────────────────────────
router.get('/repos', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const conn = await getConnection(req.user!.id);
  if (!conn) { res.status(403).json({ error: 'GitHub account not connected.' }); return; }

  try {
    const repos: { id: number; full_name: string; private: boolean; default_branch: string; html_url: string }[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await fetch(
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator`,
        { headers: ghHeaders(conn.access_token) }
      );
      if (!r.ok) throw new Error(`GitHub API error: ${r.status}`);
      const batch = await r.json() as typeof repos;
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    res.json({ repos: repos.map(r => ({
      id: r.id, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, htmlUrl: r.html_url,
    })) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/v1/github/:projectId/link ──────────────────────────────────────
router.get('/:projectId/link', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await projectService.getProject(req.params.projectId, req.user!.id);
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return;
  }
  const { data } = await supabase
    .from('project_settings')
    .select('setting_value')
    .eq('project_id', req.params.projectId)
    .eq('setting_key', 'github_repo')
    .maybeSingle();
  res.json({ link: data?.setting_value ?? null });
});

// ── POST /api/v1/github/:projectId/create-repo ───────────────────────────────
// Creates a brand-new repo on the connected GitHub account and links this
// project to it in one step (for users with no existing repo to push to).
router.post('/:projectId/create-repo', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { name, private: isPrivate } = req.body as { name?: string; private?: boolean };
  if (!name || !/^[\w.-]+$/.test(name)) { res.status(400).json({ error: 'name must contain only letters, numbers, "-", "_", "."' }); return; }

  try {
    await projectService.getProject(req.params.projectId, req.user!.id);
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return;
  }

  const conn = await getConnection(req.user!.id);
  if (!conn) { res.status(403).json({ error: 'GitHub account not connected.' }); return; }

  try {
    const r = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { ...ghHeaders(conn.access_token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, private: isPrivate ?? true, auto_init: true }),
    });
    const body = await r.json() as { full_name?: string; default_branch?: string; html_url?: string; message?: string };
    if (!r.ok) { res.status(r.status).json({ error: body.message ?? `GitHub API error: ${r.status}` }); return; }

    const link = { fullName: body.full_name!, branch: body.default_branch || 'main' };
    await supabase.from('project_settings').upsert(
      {
        project_id: req.params.projectId,
        setting_key: 'github_repo',
        setting_value: link,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,setting_key' }
    );
    res.json({ ...link, htmlUrl: body.html_url });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/v1/github/:projectId/link ─────────────────────────────────────
router.post('/:projectId/link', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { fullName, branch } = req.body as { fullName?: string; branch?: string };
  if (!fullName || !/^[^/]+\/[^/]+$/.test(fullName)) { res.status(400).json({ error: 'fullName must be "owner/repo".' }); return; }

  try {
    await projectService.getProject(req.params.projectId, req.user!.id);
  } catch {
    res.status(404).json({ error: 'Project not found or access denied.' });
    return;
  }

  await supabase.from('project_settings').upsert(
    {
      project_id: req.params.projectId,
      setting_key: 'github_repo',
      setting_value: { fullName, branch: branch || 'main' },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project_id,setting_key' }
  );
  res.json({ success: true });
});

// ── POST /api/v1/github/:projectId/push ─────────────────────────────────────
// Pushes the project's current files as a single commit to the linked repo/branch.
router.post('/:projectId/push', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  try {
    let project: any;
    try {
      project = await projectService.getProject(projectId, req.user!.id);
    } catch {
      res.status(404).json({ error: 'Project not found or access denied.' });
      return;
    }

    const conn = await getConnection(req.user!.id);
    if (!conn) { res.status(403).json({ error: 'GitHub account not connected.' }); return; }

    const { data: linkRow } = await supabase
      .from('project_settings')
      .select('setting_value')
      .eq('project_id', projectId)
      .eq('setting_key', 'github_repo')
      .maybeSingle();
    const link = linkRow?.setting_value as { fullName?: string; branch?: string } | undefined;
    if (!link?.fullName) { res.status(400).json({ error: 'No GitHub repo linked to this project yet.' }); return; }

    const [owner, repo] = link.fullName.split('/');
    const branch = link.branch || 'main';
    const headers = ghHeaders(conn.access_token);

    const appPath = resolveProjectPath(projectId, (project as any)?.server_path);
    const files = walkProjectFiles(appPath);
    if (files.length === 0) { res.status(400).json({ error: 'No files found to push — build the project first.' }); return; }

    // Resolve current branch tip (may not exist yet on an empty repo).
    let baseCommitSha: string | undefined;
    const refRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`, { headers });
    if (refRes.ok) {
      const refJson = await refRes.json() as { object: { sha: string } };
      baseCommitSha = refJson.object.sha;
    }

    let baseTreeSha: string | undefined;
    if (baseCommitSha) {
      const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits/${baseCommitSha}`, { headers });
      if (commitRes.ok) baseTreeSha = ((await commitRes.json()) as { tree: { sha: string } }).tree.sha;
    }

    // Create a blob per file, then one tree, one commit, one ref update — an
    // atomic single commit instead of one commit per file.
    const treeEntries = [];
    for (const f of files) {
      const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST', headers,
        body: JSON.stringify({ content: Buffer.from(f.content).toString('base64'), encoding: 'base64' }),
      });
      if (!blobRes.ok) throw new Error(`Failed to create blob for ${f.path}: ${blobRes.status}`);
      const blob = await blobRes.json() as { sha: string };
      treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
      method: 'POST', headers,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
    });
    if (!treeRes.ok) throw new Error(`Failed to create tree: ${treeRes.status}`);
    const tree = await treeRes.json() as { sha: string };

    const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
      method: 'POST', headers,
      body: JSON.stringify({
        message: `Sync from EcomGear — ${new Date().toISOString()}`,
        tree: tree.sha,
        parents: baseCommitSha ? [baseCommitSha] : [],
      }),
    });
    if (!commitRes.ok) throw new Error(`Failed to create commit: ${commitRes.status}`);
    const commit = await commitRes.json() as { sha: string };

    const updateRefRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: baseCommitSha ? 'PATCH' : 'POST',
      headers,
      body: JSON.stringify(
        baseCommitSha
          ? { sha: commit.sha, force: false }
          : { ref: `refs/heads/${branch}`, sha: commit.sha }
      ),
    });
    if (!updateRefRes.ok) throw new Error(`Failed to update ref: ${updateRefRes.status}`);

    res.json({ success: true, filesPushed: files.length, commitUrl: `https://github.com/${owner}/${repo}/commit/${commit.sha}` });
  } catch (err) {
    logger.error('[GitHub push] error', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.dyad']);

function walkProjectFiles(dir: string, base = dir, results: { path: string; content: string }[] = []): { path: string; content: string }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkProjectFiles(full, base, results);
    } else {
      const rel = path.relative(base, full).split(path.sep).join('/');
      try {
        results.push({ path: rel, content: fs.readFileSync(full, 'utf8') });
      } catch { /* skip unreadable/binary files for MVP */ }
    }
  }
  return results;
}

export default router;
