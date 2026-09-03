/**
 * Servers: status of every registered platform service. The API probes each
 * one (background monitor every 5 min plus on demand) and keeps 24h of
 * checks, which drive the uptime figure and the status strip.
 */
import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Page, Stats, Panel, Table, Tag, btn, input, ago } from '@/components/admin/ui';
import { adminServersService, type AppServer, type AppServerInput, type ServerHealth, type ServerRole } from '@/services/adminOpsService';

const ROLE: Record<ServerRole, string> = { api: 'API', gen: 'Agent runner', preview: 'Preview', hosting: 'Hosting', tenant_db: 'Tenant DB', functions: 'Functions', web: 'Web', other: 'Other' };
const TONE: Record<ServerHealth, 'ok' | 'warn' | 'bad' | 'gray'> = { healthy: 'ok', degraded: 'warn', unreachable: 'bad', unknown: 'gray' };
const LABEL: Record<ServerHealth, string> = { healthy: 'Healthy', degraded: 'Degraded', unreachable: 'Down', unknown: 'Unchecked' };
const BAR: Record<string, string> = { healthy: 'bg-emerald-400', degraded: 'bg-amber-400', unreachable: 'bg-red-400' };
const EMPTY: AppServerInput = { name: '', role: 'other', base_url: '', health_path: '/health', host: '', notes: '' };
const REFRESH_MS = 60_000;

function Strip({ history }: { history: AppServer['history'] }) {
  if (history.length === 0) return <span className="text-gray-600">—</span>;
  return (
    <div className="flex items-end gap-px h-4" title={`${history.length} checks, oldest left`}>
      {history.map((h, i) => (
        <span key={i} className={cn('w-1 rounded-sm', BAR[h.status])} style={{ height: h.status === 'healthy' ? '100%' : '55%' }} title={`${h.status} · ${h.latency_ms ?? '?'} ms · ${new Date(h.checked_at).toLocaleTimeString()}`} />
      ))}
    </div>
  );
}

export default function AdminServers() {
  const [servers, setServers] = useState<AppServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState<string | 'all' | null>(null);
  const [editing, setEditing] = useState<AppServer | 'new' | null>(null);
  const [form, setForm] = useState<AppServerInput>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<AppServer | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try { setServers(await adminServersService.list()); }
    catch (e) { if (!quiet) toast.error(e instanceof Error ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const replace = (next: AppServer) => setServers((prev) => prev.map((s) => (s.id === next.id ? { ...s, ...next } : s)));

  const checkAll = async () => {
    setChecking('all');
    try {
      const list = await adminServersService.checkAll();
      setServers(list);
      const bad = list.filter((s) => s.enabled && s.health_status !== 'healthy').length;
      if (bad) toast.warning(`${bad} not healthy`); else toast.success('All healthy');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Check failed'); }
    finally { setChecking(null); }
  };

  const checkOne = async (s: AppServer) => {
    setChecking(s.id);
    try { replace(await adminServersService.check(s.id)); await load(true); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Check failed'); }
    finally { setChecking(null); }
  };

  const open = (s: AppServer | 'new') => {
    setForm(s === 'new' ? EMPTY : { name: s.name, role: s.role, base_url: s.base_url, health_path: s.health_path, host: s.host ?? '', notes: s.notes ?? '' });
    setEditing(s);
  };

  const save = async () => {
    if (!form.name.trim() || !form.base_url.trim()) { toast.error('Name and URL required'); return; }
    setSaving(true);
    const payload: AppServerInput = { ...form, host: form.host || null, notes: form.notes || null };
    try {
      if (editing === 'new') await adminServersService.create(payload);
      else if (editing) await adminServersService.update(editing.id, payload);
      setEditing(null);
      await load(true);
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  };

  const toggle = async (s: AppServer) => {
    try { replace(await adminServersService.update(s.id, { enabled: !s.enabled })); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed'); }
  };

  const remove = async () => {
    if (!removing) return;
    try { await adminServersService.remove(removing.id); setServers((p) => p.filter((s) => s.id !== removing.id)); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed'); }
    finally { setRemoving(null); }
  };

  const enabled = servers.filter((s) => s.enabled);
  const down = enabled.filter((s) => s.health_status === 'unreachable').length;
  const degraded = enabled.filter((s) => s.health_status === 'degraded').length;
  const uptimes = enabled.map((s) => s.uptime_24h).filter((u): u is number => u !== null);
  const avgUptime = uptimes.length ? Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 10) / 10 : null;

  return (
    <Page
      title="Servers"
      actions={<>
        <button className={btn.ghost} onClick={() => open('new')}>Add</button>
        <button className={btn.primary} onClick={checkAll} disabled={checking !== null || servers.length === 0}>{checking === 'all' ? 'Checking…' : 'Check now'}</button>
      </>}
    >
      <Stats items={[
        { label: 'Servers', value: enabled.length },
        { label: 'Down', value: down, tone: down ? 'bad' : 'ok' },
        { label: 'Degraded', value: degraded, tone: degraded ? 'warn' : 'ok' },
        { label: 'Uptime 24h', value: avgUptime === null ? '—' : `${avgUptime}%`, tone: avgUptime === null ? undefined : avgUptime >= 99 ? 'ok' : avgUptime >= 95 ? 'warn' : 'bad' },
      ]} />

      <Panel>
        <Table head={['Status', 'Server', 'Endpoint', 'Latency', 'Uptime 24h', 'Last 24h', 'Checked', '']} empty={loading ? 'Loading…' : 'No servers'}>
          {servers.map((s) => (
            <tr key={s.id} className={cn(!s.enabled && 'opacity-40')}>
              <td><Tag tone={TONE[s.health_status]}>{LABEL[s.health_status]}{s.health_http != null ? ` ${s.health_http}` : ''}</Tag></td>
              <td>
                <div className="text-white">{s.name} <span className="text-gray-500 text-[11px]">{ROLE[s.role]}</span></div>
                {s.host && <div className="text-[11px] text-gray-500 font-mono">{s.host}</div>}
              </td>
              <td><a href={s.base_url.replace(/\/$/, '') + s.health_path} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-gray-300 hover:text-white">{s.base_url.replace(/^https?:\/\//, '')}{s.health_path}</a></td>
              <td className="text-gray-300">{s.health_latency_ms != null ? `${s.health_latency_ms} ms` : '—'}</td>
              <td className={cn(s.uptime_24h === null ? 'text-gray-500' : s.uptime_24h >= 99 ? 'text-emerald-400' : s.uptime_24h >= 95 ? 'text-amber-400' : 'text-red-400')}>{s.uptime_24h === null ? '—' : `${s.uptime_24h}%`} <span className="text-gray-600 text-[11px]">{s.checks_24h ? `${s.checks_24h}` : ''}</span></td>
              <td><Strip history={s.history} /></td>
              <td className="text-gray-400" title={s.health_last_check ?? ''}>{ago(s.health_last_check)}</td>
              <td className="text-right whitespace-nowrap">
                <button className={btn.icon + ' w-auto px-2'} disabled={checking !== null} onClick={() => checkOne(s)}>{checking === s.id ? '…' : 'Check'}</button>
                <button className={btn.icon + ' w-auto px-2'} onClick={() => toggle(s)}>{s.enabled ? 'Pause' : 'Resume'}</button>
                <button className={btn.icon + ' w-auto px-2'} onClick={() => open(s)}>Edit</button>
                <button className={btn.icon + ' w-auto px-2 hover:text-red-400'} onClick={() => setRemoving(s)}>Delete</button>
              </td>
            </tr>
          ))}
        </Table>
      </Panel>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="bg-[#0f1116] border-white/10 text-white sm:max-w-md">
          <DialogHeader><DialogTitle className="text-sm">{editing === 'new' ? 'Add server' : 'Edit server'}</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <input className={input} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Select value={form.role} onValueChange={(v: ServerRole) => setForm({ ...form, role: v })}>
              <SelectTrigger className="h-8 text-xs bg-transparent border-white/10"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(ROLE) as ServerRole[]).map((r) => <SelectItem key={r} value={r}>{ROLE[r]}</SelectItem>)}</SelectContent>
            </Select>
            <input className={input + ' font-mono'} placeholder="https://host" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} />
            <input className={input + ' font-mono'} placeholder="/health" value={form.health_path} onChange={(e) => setForm({ ...form, health_path: e.target.value })} />
            <input className={input + ' font-mono'} placeholder="IP (optional)" value={form.host ?? ''} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            <input className={input} placeholder="Notes (optional)" value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <DialogFooter>
            <button className={btn.ghost} onClick={() => setEditing(null)}>Cancel</button>
            <button className={btn.primary} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent className="bg-[#0f1116] border-white/10 text-white sm:max-w-sm">
          <DialogHeader><DialogTitle className="text-sm">Delete {removing?.name}?</DialogTitle></DialogHeader>
          <DialogFooter>
            <button className={btn.ghost} onClick={() => setRemoving(null)}>Cancel</button>
            <button className={btn.danger} onClick={remove}>Delete</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
