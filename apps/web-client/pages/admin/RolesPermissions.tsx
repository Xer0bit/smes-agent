/**
 * Roles: platform role holders verified against auth, the issues to act on,
 * role changes (audited), and organization memberships.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Page, Stats, Panel, Table, Tag, btn, input, when } from '@/components/admin/ui';
import { adminRolesService, type PlatformRole, type RoleHolder, type RoleReport } from '@/services/adminOpsService';

interface OrgRoleRow { id: string; org_name: string; user_email: string; role: string; created_at: string }
const ACTION: Record<string, string> = { grant: 'granted', change: 'changed', revoke: 'revoked', confirm_email: 'confirmed email of', ban: 'banned', unban: 'unbanned' };

export default function AdminRolesPermissions() {
  const [report, setReport] = useState<RoleReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [orgRoles, setOrgRoles] = useState<OrgRoleRow[]>([]);
  const [target, setTarget] = useState<RoleHolder | null>(null);
  const [role, setRole] = useState<PlatformRole>('admin');
  const [grant, setGrant] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Array<{ id: string; email: string }>>([]);
  const [pick, setPick] = useState<{ id: string; email: string } | null>(null);
  const [grantRole, setGrantRole] = useState<PlatformRole>('admin');

  const load = useCallback(async () => {
    setLoading(true);
    try { setReport(await adminRolesService.report()); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, []);

  const loadOrgRoles = useCallback(async () => {
    const { data, error } = await supabase.from('org_members').select('id, role, created_at, org_id, user_id').order('created_at', { ascending: false });
    if (error) { toast.error(error.message); return; }
    const rows = data ?? [];
    const orgIds = [...new Set(rows.map((r) => r.org_id).filter(Boolean))];
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const [orgs, profiles] = await Promise.all([
      orgIds.length ? supabase.from('organizations').select('id, name').in('id', orgIds) : Promise.resolve({ data: [] }),
      userIds.length ? supabase.from('profiles').select('id, email').in('id', userIds) : Promise.resolve({ data: [] }),
    ]);
    const orgMap = new Map((orgs.data ?? []).map((o) => [o.id, o.name]));
    const emailMap = new Map((profiles.data ?? []).map((p) => [p.id, p.email]));
    setOrgRoles(rows.map((r) => ({ id: r.id, role: r.role, created_at: r.created_at, org_name: orgMap.get(r.org_id) ?? '?', user_email: emailMap.get(r.user_id) ?? '?' })));
  }, []);

  useEffect(() => { load(); loadOrgRoles(); }, [load, loadOrgRoles]);

  useEffect(() => {
    if (!grant || query.trim().length < 2) { setMatches([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase.from('profiles').select('id, email').ilike('email', `%${query.trim()}%`).limit(8);
      setMatches(data ?? []);
    }, 250);
    return () => clearTimeout(t);
  }, [grant, query]);

  const isSuper = report?.caller.role === 'super_admin';
  const me = report?.caller.user_id;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };

  const holders = report?.holders ?? [];
  const issues = report?.issues ?? [];
  const orgIssues = report?.orgIssues ?? [];

  return (
    <Page
      title="Roles"
      actions={<>
        <button className={btn.ghost} onClick={load} disabled={loading}>Re-verify</button>
        {isSuper && <button className={btn.primary} onClick={() => setGrant(true)}>Grant</button>}
      </>}
    >
      <Stats items={[
        { label: 'Super admins', value: holders.filter((h) => h.role === 'super_admin').length },
        { label: 'Admins', value: holders.filter((h) => h.role === 'admin').length },
        { label: 'Issues', value: issues.length, tone: issues.length ? 'bad' : 'ok' },
        { label: 'Orgs without admin', value: orgIssues.length, tone: orgIssues.length ? 'warn' : 'ok' },
      ]} />

      {(issues.length > 0 || orgIssues.length > 0) && (
        <Panel title="Needs attention">
          <div className="divide-y divide-white/[0.06]">
            {issues.map((i, idx) => {
              const h = holders.find((x) => x.user_id === i.user_id);
              return (
                <div key={idx} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                  <span className="text-gray-200">{i.message}</span>
                  {isSuper && h && (
                    <span className="flex gap-1 shrink-0">
                      {i.code === 'unconfirmed' && <button className={btn.ghost} disabled={busy} onClick={() => run(() => adminRolesService.confirmEmail(h.user_id), 'Email confirmed')}>Confirm email</button>}
                      {i.code === 'banned' && <button className={btn.ghost} disabled={busy} onClick={() => run(() => adminRolesService.ban(h.user_id, true), 'Unbanned')}>Unban</button>}
                      <button className={btn.danger} disabled={busy || h.user_id === me} onClick={() => run(() => adminRolesService.setRole(h.user_id, 'user'), 'Role revoked')}>Revoke</button>
                    </span>
                  )}
                </div>
              );
            })}
            {orgIssues.map((o) => <div key={o.org_id} className="px-3 py-2 text-[13px] text-gray-200">{o.name}: no admin member</div>)}
          </div>
        </Panel>
      )}

      <Panel title="Platform roles">
        <Table head={['User', 'Role', 'Verified', 'Last sign-in', 'Granted', '']} empty={loading ? 'Loading…' : 'No platform roles'}>
          {holders.map((h) => (
            <tr key={h.id}>
              <td><span className="text-white">{h.email ?? h.user_id}</span>{h.full_name && <span className="text-gray-500 text-[11px]"> {h.full_name}</span>}</td>
              <td><Tag tone={h.role === 'super_admin' ? 'warn' : 'accent'}>{h.role.replace('_', ' ')}</Tag></td>
              <td>
                <span className={cn(h.verified ? 'text-emerald-400' : 'text-red-400')}>{h.verified ? 'Yes' : 'No'}</span>
                <span className="text-[11px] text-gray-500"> {[
                  !h.checks.auth_exists && 'no account', !h.checks.email_confirmed && 'email unconfirmed', !h.checks.not_banned && 'banned', !h.checks.profile_active && 'inactive', h.checks.mfa && 'mfa',
                ].filter(Boolean).join(' · ')}</span>
              </td>
              <td className="text-gray-400">{when(h.last_sign_in_at)}</td>
              <td className="text-gray-400">{when(h.granted_at)}</td>
              <td className="text-right whitespace-nowrap">
                {isSuper && <>
                  <button className={btn.icon + ' w-auto px-2'} disabled={busy} onClick={() => { setRole(h.role); setTarget(h); }}>Change</button>
                  {h.user_id !== me && h.checks.auth_exists && (
                    <button className={btn.icon + ' w-auto px-2 hover:text-red-400'} disabled={busy} onClick={() => run(() => adminRolesService.ban(h.user_id, !h.checks.not_banned), h.checks.not_banned ? 'Banned, role revoked' : 'Unbanned')}>{h.checks.not_banned ? 'Ban' : 'Unban'}</button>
                  )}
                </>}
              </td>
            </tr>
          ))}
        </Table>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel title="Role changes">
          <div className="divide-y divide-white/[0.06] max-h-[400px] overflow-y-auto">
            {(report?.audit ?? []).length === 0 && <div className="px-3 py-6 text-center text-gray-500 text-[13px]">None yet</div>}
            {(report?.audit ?? []).map((a) => (
              <div key={a.id} className="px-3 py-2 text-[12px] flex justify-between gap-3">
                <span className="text-gray-300"><span className="text-white">{a.actor_email ?? 'system'}</span> {ACTION[a.action] ?? a.action} <span className="text-white">{a.target_email ?? a.target_user_id.slice(0, 8)}</span>{a.new_role && <span className="text-gray-500"> {a.old_role ? `${a.old_role} → ` : ''}{a.new_role}</span>}</span>
                <span className="text-gray-500 shrink-0">{when(a.created_at)}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Organization roles">
          <div className="max-h-[400px] overflow-y-auto">
            <Table head={['Organization', 'Member', 'Role', 'Since']} empty="No memberships">
              {orgRoles.map((r) => (
                <tr key={r.id}>
                  <td className="text-white">{r.org_name}</td>
                  <td>{r.user_email}</td>
                  <td><Tag>{r.role}</Tag></td>
                  <td className="text-gray-400">{when(r.created_at)}</td>
                </tr>
              ))}
            </Table>
          </div>
        </Panel>
      </div>

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="bg-[#0f1116] border-white/10 text-white sm:max-w-sm">
          <DialogHeader><DialogTitle className="text-sm">{target?.email}</DialogTitle></DialogHeader>
          <Select value={role} onValueChange={(v: PlatformRole) => setRole(v)}>
            <SelectTrigger className="h-8 text-xs bg-transparent border-white/10"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="user">user (no access)</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
              <SelectItem value="super_admin">super admin</SelectItem>
            </SelectContent>
          </Select>
          <DialogFooter>
            <button className={btn.ghost} onClick={() => setTarget(null)}>Cancel</button>
            <button className={btn.primary} disabled={target?.user_id === me && role !== 'super_admin'} onClick={() => { const t = target; setTarget(null); if (t) run(() => adminRolesService.setRole(t.user_id, role), `${t.email ?? 'User'}: ${role}`); }}>Apply</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={grant} onOpenChange={(o) => { if (!o) { setGrant(false); setQuery(''); setPick(null); } }}>
        <DialogContent className="bg-[#0f1116] border-white/10 text-white sm:max-w-sm">
          <DialogHeader><DialogTitle className="text-sm">Grant role</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <input className={input} placeholder="Email" value={query} onChange={(e) => { setQuery(e.target.value); setPick(null); }} />
            {matches.length > 0 && !pick && (
              <div className="border border-white/10 rounded-md divide-y divide-white/[0.06] max-h-40 overflow-y-auto">
                {matches.map((m) => <button key={m.id} type="button" className="block w-full text-left px-2 py-1.5 text-xs hover:bg-white/5" onClick={() => { setPick(m); setQuery(m.email); }}>{m.email}</button>)}
              </div>
            )}
            <Select value={grantRole} onValueChange={(v: PlatformRole) => setGrantRole(v)}>
              <SelectTrigger className="h-8 text-xs bg-transparent border-white/10"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="admin">admin</SelectItem><SelectItem value="super_admin">super admin</SelectItem></SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <button className={btn.ghost} onClick={() => setGrant(false)}>Cancel</button>
            <button className={btn.primary} disabled={!pick} onClick={() => { const p = pick; setGrant(false); setQuery(''); setPick(null); if (p) run(() => adminRolesService.setRole(p.id, grantRole), `${p.email}: ${grantRole}`); }}>Grant</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
