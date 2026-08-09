// eCG fleet visibility -- lists every ecomgear.dev dashboard connected to an
// eCG Agents org via MCP key (server/src/routes/ecg-dev-agent.routes.ts),
// which agent(s) each one manages, and who owns it. Same direct-Supabase-read
// pattern AdminHosting.tsx already uses for its read-only tables (only
// mutations go through a backend route); no new backend endpoint needed for
// this list.
//
// Deliberately does NOT pull live spend/usage/billing numbers from
// agent-portal (mcp.ecomgear.ai) -- its admin routes are gated by an
// agent-portal super-admin session, not a machine credential this app can
// present today. That's a real, separate decision (does agent-portal get a
// service-API-key admin path?) tracked for later, not silently faked here.
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Search, Bot, RefreshCw, Loader2, Zap, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';

interface EcgDashboardRow {
  projectId: string;
  projectName: string;
  ownerEmail: string | null;
  orgName: string | null;
  ecgOrgName: string | null;
  agentCount: number;
  agentNames: string[];
  modules: string[];
  updatedAt: string | null;
}

export default function AdminEcgAgents() {
  const [rows, setRows] = useState<EcgDashboardRow[]>([]);
  const [filtered, setFiltered] = useState<EcgDashboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Every project with an MCP key secret IS an eCG-connected dashboard --
      // ecg-dev-agent.routes.ts writes this on every successful provision.
      const { data: secretRows, error: secretsErr } = await supabase
        .from('project_secrets')
        .select('project_id')
        .eq('key_name', 'ECG_MCP_API_KEY');
      if (secretsErr) throw secretsErr;

      const projectIds = [...new Set((secretRows ?? []).map((r: any) => r.project_id))];
      if (projectIds.length === 0) { setRows([]); setFiltered([]); return; }

      const [{ data: projects, error: projErr }, { data: settingsRows, error: settingsErr }] = await Promise.all([
        supabase.from('projects')
          .select('id, name, user_id, updated_at, organizations(name)')
          .in('id', projectIds),
        supabase.from('project_settings')
          .select('project_id, setting_value')
          .eq('setting_key', 'ecg_customizer')
          .in('project_id', projectIds),
      ]);
      if (projErr) throw projErr;
      if (settingsErr) throw settingsErr;

      const ownerIds = [...new Set((projects ?? []).map((p: any) => p.user_id).filter(Boolean))];
      let emailByOwner: Record<string, string> = {};
      if (ownerIds.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, email').in('id', ownerIds);
        emailByOwner = Object.fromEntries((profiles ?? []).map((p: any) => [p.id, p.email]));
      }

      const settingsByProject = Object.fromEntries(
        (settingsRows ?? []).map((r: any) => [r.project_id, r.setting_value ?? {}]),
      );

      const built: EcgDashboardRow[] = (projects ?? []).map((p: any) => {
        const cfg = settingsByProject[p.id] ?? {};
        const agentIds: string[] = Array.isArray(cfg.agentIds) ? cfg.agentIds : [];
        const agentNames: Record<string, string> = cfg.agentNames ?? {};
        return {
          projectId: p.id,
          projectName: p.name,
          ownerEmail: emailByOwner[p.user_id] ?? null,
          orgName: p.organizations?.name ?? null,
          ecgOrgName: cfg.orgName ?? null,
          agentCount: agentIds.length,
          agentNames: agentIds.map((id) => agentNames[id] ?? id),
          modules: Array.isArray(cfg.modules) ? cfg.modules : [],
          updatedAt: p.updated_at ?? null,
        };
      });

      setRows(built);
      setFiltered(built);
    } catch (e: any) {
      console.error('Failed to load eCG fleet:', e);
      setError(e?.message ?? 'Failed to load eCG-connected dashboards');
      toast.error('Failed to load eCG fleet');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!searchQuery.trim()) { setFiltered(rows); return; }
    const q = searchQuery.toLowerCase();
    setFiltered(rows.filter((r) =>
      r.projectName.toLowerCase().includes(q) ||
      (r.ownerEmail ?? '').toLowerCase().includes(q) ||
      (r.orgName ?? '').toLowerCase().includes(q) ||
      (r.ecgOrgName ?? '').toLowerCase().includes(q) ||
      r.agentNames.some((n) => n.toLowerCase().includes(q)),
    ));
  }, [searchQuery, rows]);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">eCG Agent Dashboards</h1>
          <p className="text-sm text-gray-400 mt-1">
            Every ecomgear.dev dashboard connected to an eCG Agents org via MCP key, and which agent(s) it manages.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="border-white/[0.06] bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-gray-400 uppercase tracking-wider flex items-center gap-2">
              <Bot className="h-3.5 w-3.5" />
              Connected dashboards
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold text-white">{loading ? '...' : rows.length}</span>
          </CardContent>
        </Card>
        <Card className="border-white/[0.06] bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-gray-400 uppercase tracking-wider flex items-center gap-2">
              <Zap className="h-3.5 w-3.5" />
              Total managed agents
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold text-white">
              {loading ? '...' : rows.reduce((sum, r) => sum + r.agentCount, 0)}
            </span>
          </CardContent>
        </Card>
        <Card className="border-white/[0.06] bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Multi-agent dashboards
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold text-white">
              {loading ? '...' : rows.filter((r) => r.agentCount > 1).length}
            </span>
          </CardContent>
        </Card>
      </div>

      <Card className="border-white/[0.06] bg-white/[0.02]">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold text-white flex items-center gap-2">
              <Bot className="h-4 w-4 text-blue-400" />
              Dashboards
              <Badge variant="secondary" className="ml-2">{filtered.length}</Badge>
            </CardTitle>
            <div className="relative w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
              <Input
                placeholder="Search dashboards, owners, agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 bg-white/[0.03] border-white/[0.08] text-sm"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
            </div>
          ) : error ? (
            <div className="text-center py-12 text-red-400 text-sm">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-gray-500 text-sm">
              {searchQuery ? 'No dashboards match your search' : 'No eCG-connected dashboards yet'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-white/[0.06]">
                  <TableHead className="text-gray-400">Dashboard</TableHead>
                  <TableHead className="text-gray-400">Owner</TableHead>
                  <TableHead className="text-gray-400">eCG Org</TableHead>
                  <TableHead className="text-gray-400">Managed Agents</TableHead>
                  <TableHead className="text-gray-400">Modules</TableHead>
                  <TableHead className="text-gray-400">Updated</TableHead>
                  <TableHead className="text-gray-400 text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => (
                  <TableRow key={r.projectId} className="border-white/[0.04]">
                    <TableCell>
                      <span className="text-sm font-medium text-white">{r.projectName}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-gray-400">{r.ownerEmail ?? ' '}</span>
                      {r.orgName && <span className="block text-xs text-gray-500">{r.orgName}</span>}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-gray-300">{r.ecgOrgName ?? ' '}</span>
                    </TableCell>
                    <TableCell>
                      {r.agentCount === 0 ? (
                        <span className="text-sm text-gray-500">None</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {r.agentNames.slice(0, 4).map((name, i) => (
                            <Badge key={i} variant="outline" className="text-[10px]">{name}</Badge>
                          ))}
                          {r.agentCount > 4 && <Badge variant="secondary" className="text-[10px]">+{r.agentCount - 4}</Badge>}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-gray-500">{r.modules.length > 0 ? r.modules.join(', ') : 'all'}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-gray-400">{r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : ' '}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-gray-400 hover:text-white"
                        onClick={() => window.open(`/project/${r.projectId}`, '_blank')}>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
