/**
 * Platform admin: application server registry with server-side health probes
 * and platform role verification.
 *
 * Mounted at /api/v1/admin. Reads that RLS already allows happen from the
 * browser; everything here is either a write RLS blocks or a probe the
 * browser cannot make (CORS, mixed content, private hosts).
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { requireAdmin } from './system.routes.js';
import { supabase } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { safeErrorMessage } from '../utils/sendError.js';
import { checkServer, checkAllEnabled, listServersWithStatus } from '../services/serverStatus.service.js';

const router = Router();
router.use(authMiddleware);

async function callerRole(userId: string): Promise<'super_admin' | 'admin' | null> {
  const { data } = await supabase.from('user_roles').select('role').eq('user_id', userId).in('role', ['super_admin', 'admin']).maybeSingle();
  return (data?.role as 'super_admin' | 'admin' | undefined) ?? null;
}

async function requireSuperAdmin(req: AuthenticatedRequest, res: Response): Promise<boolean> {
  if (!(await requireAdmin(req, res))) return false;
  if ((await callerRole(req.user!.id)) !== 'super_admin') {
    res.status(403).json({ error: 'Super admin access required' });
    return false;
  }
  return true;
}

// ═══════════════════════════ Application servers ═══════════════════════════

const serverSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(['api', 'gen', 'preview', 'hosting', 'tenant_db', 'functions', 'web', 'other']).default('other'),
  base_url: z.string().trim().url().max(300),
  health_path: z.string().trim().max(200).default('/health'),
  host: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
});

router.get('/servers', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    res.json({ servers: await listServersWithStatus() });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post('/servers', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const parsed = serverSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid server' }); return; }
    const { data, error } = await supabase.from('app_servers').insert(parsed.data).select('*').single();
    if (error) { res.status(error.code === '23505' ? 409 : 500).json({ error: error.message }); return; }
    res.status(201).json({ server: await checkServer(data) });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch('/servers/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const parsed = serverSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid server' }); return; }
    const { data, error } = await supabase.from('app_servers').update(parsed.data).eq('id', req.params.id).select('*').maybeSingle();
    if (error) { res.status(error.code === '23505' ? 409 : 500).json({ error: error.message }); return; }
    if (!data) { res.status(404).json({ error: 'Server not found' }); return; }
    res.json({ server: data });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.delete('/servers/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { error } = await supabase.from('app_servers').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Probe every enabled server in parallel and persist the results.
router.post('/servers/check', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    await checkAllEnabled();
    res.json({ servers: await listServersWithStatus() });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post('/servers/:id/check', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const { data } = await supabase.from('app_servers').select('id, base_url, health_path').eq('id', req.params.id).maybeSingle();
    if (!data) { res.status(404).json({ error: 'Server not found' }); return; }
    res.json({ server: await checkServer(data) });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ═══════════════════════════ Roles & verification ══════════════════════════

const ROLES = ['user', 'admin', 'super_admin'] as const;
type Role = typeof ROLES[number];

interface AuthUserLite { id: string; email: string | null; email_confirmed_at: string | null; last_sign_in_at: string | null; banned_until: string | null; factors: number }

async function listAuthUsers(): Promise<Map<string, AuthUserLite>> {
  const out = new Map<string, AuthUserLite>();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    for (const u of data.users) {
      out.set(u.id, {
        id: u.id, email: u.email ?? null, email_confirmed_at: u.email_confirmed_at ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
        banned_until: (u as unknown as { banned_until?: string }).banned_until ?? null,
        factors: (u.factors ?? []).filter((f) => f.status === 'verified').length,
      });
    }
    if (data.users.length < 200) break;
  }
  return out;
}

/**
 * Every platform role holder cross-checked against auth.users, plus the
 * integrity problems an admin should act on.
 */
router.get('/roles', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const [{ data: roleRows, error: roleErr }, auth, { data: audit }] = await Promise.all([
      supabase.from('user_roles').select('id, user_id, role, created_at').order('created_at'),
      listAuthUsers(),
      supabase.from('role_audit').select('*').order('created_at', { ascending: false }).limit(50),
    ]);
    if (roleErr) throw new Error(roleErr.message);
    const auditRows = audit ?? [];
    const userIds = [...new Set([
      ...(roleRows ?? []).map((r) => r.user_id),
      ...auditRows.flatMap((a) => [a.actor_id, a.target_user_id].filter((x): x is string => Boolean(x))),
    ])];
    const { data: profiles } = userIds.length
      ? await supabase.from('profiles').select('id, email, full_name, account_status, last_login_at').in('id', userIds)
      : { data: [] as Array<{ id: string; email: string; full_name: string | null; account_status: string | null; last_login_at: string | null }> };
    const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
    const emailOf = (id: string | null) => (id ? profileMap.get(id)?.email ?? auth.get(id)?.email ?? null : null);

    const issues: Array<{ code: string; user_id: string; email: string | null; message: string }> = [];
    const holders = (roleRows ?? []).map((r) => {
      const a = auth.get(r.user_id);
      const p = profileMap.get(r.user_id);
      const email = a?.email ?? p?.email ?? null;
      const checks = {
        auth_exists: Boolean(a),
        email_confirmed: Boolean(a?.email_confirmed_at),
        not_banned: !a?.banned_until || new Date(a.banned_until) < new Date(),
        profile_active: !p || (p.account_status ?? 'active') === 'active',
        mfa: (a?.factors ?? 0) > 0,
      };
      if (r.role !== 'user') {
        if (!checks.auth_exists) issues.push({ code: 'orphan', user_id: r.user_id, email, message: `${r.role} role points at a user that no longer exists in auth` });
        else if (!checks.email_confirmed) issues.push({ code: 'unconfirmed', user_id: r.user_id, email, message: `${r.role} ${email ?? r.user_id} has not confirmed their email` });
        if (!checks.not_banned) issues.push({ code: 'banned', user_id: r.user_id, email, message: `${r.role} ${email ?? r.user_id} is banned but still holds the role` });
        if (!checks.profile_active) issues.push({ code: 'inactive_profile', user_id: r.user_id, email, message: `${r.role} ${email ?? r.user_id} has a ${p?.account_status} profile` });
      }
      const verified = r.role === 'user' || (checks.auth_exists && checks.email_confirmed && checks.not_banned && checks.profile_active);
      return {
        id: r.id, user_id: r.user_id, role: r.role as Role, granted_at: r.created_at,
        email, full_name: p?.full_name ?? null,
        email_confirmed_at: a?.email_confirmed_at ?? null, last_sign_in_at: a?.last_sign_in_at ?? p?.last_login_at ?? null,
        banned_until: a?.banned_until ?? null, mfa_factors: a?.factors ?? 0, account_status: p?.account_status ?? null,
        checks, verified,
      };
    });
    const superAdmins = holders.filter((h) => h.role === 'super_admin' && h.verified).length;
    if (superAdmins === 0) issues.push({ code: 'no_super_admin', user_id: '', email: null, message: 'No verified super admin exists' });

    // Organizations without any admin member cannot be managed by their users.
    const { data: orgs } = await supabase.from('organizations').select('id, name');
    const { data: members } = await supabase.from('org_members').select('org_id, role');
    const adminOrgs = new Set((members ?? []).filter((m) => m.role === 'admin').map((m) => m.org_id));
    const orgIssues = (orgs ?? []).filter((o) => !adminOrgs.has(o.id)).map((o) => ({ org_id: o.id, name: o.name }));

    res.json({
      holders, issues, orgIssues,
      audit: auditRows.map((a) => ({ ...a, actor_email: emailOf(a.actor_id), target_email: emailOf(a.target_user_id) })),
      caller: { user_id: req.user!.id, role: await callerRole(req.user!.id) },
      checked_at: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

async function currentRole(userId: string): Promise<{ id: string; role: Role } | null> {
  const { data } = await supabase.from('user_roles').select('id, role').eq('user_id', userId).maybeSingle();
  return (data as { id: string; role: Role } | null) ?? null;
}

async function audit(actorId: string, targetId: string, action: string, oldRole: string | null, newRole: string | null) {
  const { error } = await supabase.from('role_audit').insert({ actor_id: actorId, target_user_id: targetId, action, old_role: oldRole, new_role: newRole });
  if (error) logger.warn('[admin] role_audit insert failed', { error: error.message });
}

// Set a platform role. super_admin only (matches the user_roles RLS policy).
router.put('/roles/:userId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireSuperAdmin(req, res))) return;
    const parsed = z.object({ role: z.enum(ROLES) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'role must be user, admin or super_admin' }); return; }
    const targetId = req.params.userId;
    const role = parsed.data.role;
    if (targetId === req.user!.id && role !== 'super_admin') { res.status(400).json({ error: 'You cannot remove your own super admin role' }); return; }
    const { data: profile } = await supabase.from('profiles').select('id').eq('id', targetId).maybeSingle();
    if (!profile) { res.status(404).json({ error: 'User not found' }); return; }

    const existing = await currentRole(targetId);
    let error;
    if (role === 'user') {
      ({ error } = await supabase.from('user_roles').delete().eq('user_id', targetId));
    } else if (existing) {
      ({ error } = await supabase.from('user_roles').update({ role }).eq('id', existing.id));
    } else {
      ({ error } = await supabase.from('user_roles').insert({ user_id: targetId, role }));
    }
    if (error) throw new Error(error.message);
    await audit(req.user!.id, targetId, role === 'user' ? 'revoke' : existing ? 'change' : 'grant', existing?.role ?? null, role === 'user' ? null : role);
    res.json({ success: true, role });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// Verification actions on a role holder's auth account.
router.post('/roles/:userId/confirm-email', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireSuperAdmin(req, res))) return;
    const { error } = await supabase.auth.admin.updateUserById(req.params.userId, { email_confirm: true });
    if (error) { res.status(400).json({ error: error.message }); return; }
    await audit(req.user!.id, req.params.userId, 'confirm_email', null, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post('/roles/:userId/ban', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await requireSuperAdmin(req, res))) return;
    const targetId = req.params.userId;
    if (targetId === req.user!.id) { res.status(400).json({ error: 'You cannot ban yourself' }); return; }
    const unban = req.body?.unban === true;
    const { error } = await supabase.auth.admin.updateUserById(targetId, { ban_duration: unban ? 'none' : '876000h' });
    if (error) { res.status(400).json({ error: error.message }); return; }
    if (!unban) {
      const existing = await currentRole(targetId);
      if (existing) {
        await supabase.from('user_roles').delete().eq('id', existing.id);
        await audit(req.user!.id, targetId, 'revoke', existing.role, null);
      }
    }
    await audit(req.user!.id, targetId, unban ? 'unban' : 'ban', null, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

export default router;
