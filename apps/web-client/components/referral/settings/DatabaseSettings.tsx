import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Database, Trash2, Zap, Lock, Table, Terminal, ChevronRight, RefreshCw, Play, AlertCircle, Download, Wifi, WifiOff } from "lucide-react";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { useOrganization } from "@/contexts/OrganizationContext";
import { cn } from "@/lib/utils";
import { getApiServerUrl } from "@/config/external-api";

// ── Types ────────────────────────────────────────────────────────────────────
interface TenantDb { id: string; schema_name: string; status: string; error_message: string | null; created_at: string; }
interface Column { name: string; type: string; nullable: boolean; default: string | null; }
interface TableInfo { name: string; columns: Column[]; row_count: number | null; }
interface QueryResult { rows: object[]; fields: string[]; }
interface PingResult { connected: boolean; latencyMs?: number; error?: string; }

// ── Utils ────────────────────────────────────────────────────────────────────
async function apiFetch(path: string, opts: RequestInit = {}, timeoutMs = 10_000, projectId?: string | null) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sep = path.includes('?') ? '&' : '?';
  const qs  = projectId ? `${sep}project_id=${encodeURIComponent(projectId)}` : '';
  try {
    const res = await fetch(getApiServerUrl(`/api/v1/database${path}${qs}`), {
      ...opts,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active:         "bg-green-500/15 text-green-400 border-green-500/30",
    provisioning:   "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    deprovisioning: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    error:          "bg-red-500/15 text-red-400 border-red-500/30",
  };
  const labels: Record<string, string> = { active: "Active", provisioning: "Provisioning…", deprovisioning: "Removing…", error: "Error" };
  return <Badge variant="outline" className={styles[status] || ""}>{labels[status] || status}</Badge>;
}

// ── Connection Badge ─────────────────────────────────────────────────────────
function ConnectionBadge({ ping, checking }: { ping: PingResult | null; checking: boolean }) {
  if (checking && !ping) {
    return <Badge variant="outline" className="text-white/45 border-white/[0.07]"><RefreshCw className="h-3 w-3 mr-1 animate-spin" />Checking…</Badge>;
  }
  if (!ping) return null;
  if (ping.connected) {
    return (
      <Badge variant="outline" className="bg-green-500/15 text-green-400 border-green-500/30">
        <Wifi className="h-3 w-3 mr-1" />Connected{ping.latencyMs !== undefined ? ` (${ping.latencyMs}ms)` : ''}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-red-500/15 text-red-400 border-red-500/30" title={ping.error}>
      <WifiOff className="h-3 w-3 mr-1" />Disconnected
    </Badge>
  );
}

// ── DB Info Panel (name + status only   no keys exposed) ─────────────────────
function DbInfoPanel({ schemaName }: { schemaName: string }) {
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.03] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 text-primary shrink-0" />
        <span className="text-sm font-medium">Database connected</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-white/45">Name</span>
        <code className="text-xs font-mono bg-white/[0.06] px-2 py-0.5 rounded text-white/85">{schemaName}</code>
      </div>
      <p className="text-xs text-white/30">
        Your database is active and accessible to the AI agent. Connection details are managed securely by the agent and are not displayed here.
      </p>
    </div>
  );
}

// ── Schema Browser ───────────────────────────────────────────────────────────
function SchemaBrowser({ tables, loading, onRefresh, onSelectTable, selectedTable }: {
  tables: TableInfo[]; loading: boolean; onRefresh: () => void;
  onSelectTable: (t: TableInfo) => void; selectedTable: string | null;
}) {
  if (loading) return <div className="py-8 text-center text-sm text-white/45">Loading schema…</div>;
  if (!tables.length) return (
    <div className="py-8 text-center text-sm text-white/45">
      No tables yet. Create one with the SQL editor or your app.
    </div>
  );
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-white/45">{tables.length} table{tables.length !== 1 ? 's' : ''}</span>
        <button onClick={onRefresh} className="text-xs text-white/45 hover:text-white/85 flex items-center gap-1 transition-colors duration-smooth">
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>
      {tables.map(t => (
        <button
          key={t.name}
          onClick={() => onSelectTable(t)}
          className={cn(
            "w-full text-left rounded-lg border p-3 transition-colors duration-smooth",
            selectedTable === t.name
              ? "border-primary/50 bg-primary/5"
              : "border-white/[0.07] bg-white/[0.04]/20 hover:bg-white/[0.04]/40"
          )}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Table className="h-3.5 w-3.5 text-primary/60 shrink-0" />
              <span className="text-sm font-medium font-mono">{t.name}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-white/45">
              {t.row_count !== null && <span>{t.row_count.toLocaleString()} rows</span>}
              <span>{t.columns.length} cols</span>
              <ChevronRight className="h-3 w-3" />
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {t.columns.slice(0, 5).map(c => (
              <span key={c.name} className="text-xs bg-white/[0.04] rounded px-1.5 py-0.5 font-mono text-white/45">
                {c.name}: <span className="text-white/85/50">{c.type}</span>
              </span>
            ))}
            {t.columns.length > 5 && (
              <span className="text-xs text-white/45">+{t.columns.length - 5} more</span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Table Data Viewer ────────────────────────────────────────────────────────
function TableViewer({ tableName, userId, projectId }: { tableName: string; userId?: string; projectId?: string | null }) {
  const [data, setData]   = useState<{ rows: object[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset]  = useState(0);
  const limit = 20;

  const load = useCallback(async (off: number) => {
    setLoading(true);
    try {
      const result = await apiFetch(`/tables/${encodeURIComponent(tableName)}/rows?limit=${limit}&offset=${off}`, {}, 10_000, projectId);
      setData(result);
      setOffset(off);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tableName]);

  useEffect(() => { load(0); }, [load]);

  if (loading && !data) return <div className="py-8 text-center text-sm text-white/45">Loading rows…</div>;
  if (!data || !data.rows.length) return <div className="py-8 text-center text-sm text-white/45">No rows in this table.</div>;

  const cols = Object.keys(data.rows[0] as object);

  return (
    <div className="space-y-3">
      <div className="text-xs text-white/45">{data.total.toLocaleString()} total rows</div>
      <div className="overflow-x-auto rounded-lg border border-white/[0.07] min-w-0">
        <table className="min-w-full text-xs">
          <thead className="bg-white/[0.04]">
            <tr>{cols.map(c => <th key={c} className="px-3 py-2 text-left font-medium text-white/45 font-mono whitespace-nowrap">{c}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.rows.map((row, i) => (
              <tr key={i} className="hover:bg-white/[0.04]/20 transition-colors duration-smooth">
                {cols.map(c => (
                  <td key={c} className="px-3 py-2 font-mono text-xs whitespace-nowrap max-w-[200px] truncate">
                    {JSON.stringify((row as any)[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" disabled={offset === 0 || loading} onClick={() => load(Math.max(0, offset - limit))}>Previous</Button>
        <span className="text-xs text-white/45">{offset + 1}–{Math.min(offset + limit, data.total)} of {data.total}</span>
        <Button variant="outline" size="sm" disabled={offset + limit >= data.total || loading} onClick={() => load(offset + limit)}>Next</Button>
      </div>
    </div>
  );
}

// ── SQL Editor ───────────────────────────────────────────────────────────────
function SqlEditor({ projectId }: { projectId?: string | null }) {
  const [sql, setSql]       = useState("SELECT * FROM your_table LIMIT 10;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError]   = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [role, setRole]     = useState<'anon' | 'service'>('anon');

  const run = async () => {
    setRunning(true); setError(null); setResult(null);
    try {
      const res = await apiFetch('/query', {
        method: 'POST', body: JSON.stringify({ sql, role }),
      }, 10_000, projectId);
      setResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-white/45">Role:</span>
        <button
          onClick={() => setRole('anon')}
          className={cn("text-xs px-2 py-1 rounded border transition-colors duration-smooth", role === 'anon' ? "border-primary text-primary bg-primary/10" : "border-white/[0.07] text-white/45")}
        >anon (read-only)</button>
        <button
          onClick={() => setRole('service')}
          className={cn("text-xs px-2 py-1 rounded border transition-colors duration-smooth", role === 'service' ? "border-primary text-primary bg-primary/10" : "border-white/[0.07] text-white/45")}
        >service (full access)</button>
      </div>
      <Textarea
        value={sql}
        onChange={e => setSql(e.target.value)}
        className="font-mono text-xs min-h-[120px] resize-y"
        placeholder="SELECT * FROM your_table;"
      />
      <Button size="sm" onClick={run} disabled={running} className="w-full">
        <Play className="h-3.5 w-3.5 mr-2" />
        {running ? "Running…" : "Run Query"}
      </Button>
      {error && (
        <div className="flex gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
          <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
          <p className="text-xs text-red-400 font-mono">{error}</p>
        </div>
      )}
      {result && (
        <div className="space-y-1">
          <p className="text-xs text-white/45">{result.rows.length} row{result.rows.length !== 1 ? 's' : ''} returned</p>
          {result.rows.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-white/[0.07] min-w-0">
              <table className="min-w-full text-xs">
                <thead className="bg-white/[0.04]">
                  <tr>{result.fields.map(f => <th key={f} className="px-3 py-2 text-left font-medium font-mono text-white/45 whitespace-nowrap">{f}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {result.rows.map((row, i) => (
                    <tr key={i} className="hover:bg-white/[0.04]/20">
                      {result.fields.map(f => (
                        <td key={f} className="px-3 py-2 font-mono whitespace-nowrap max-w-[200px] truncate">
                          {JSON.stringify((row as any)[f])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-white/45 py-2">Query executed successfully.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export const DatabaseSettings = ({ organizationId: _organizationIdProp, projectId }: { organizationId?: string | null; projectId?: string | null }) => {
  const { hasFeature } = useSubscription();
  const { currentOrganizationId } = useOrganization();
  const isPaid = hasFeature("ecomgear_cloud");
  const queryClient = useQueryClient();

  const [db, setDb]         = useState<TenantDb | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [loading, setLoading]             = useState(true);
  const [provisioning, setProvisioning]   = useState(false);
  const [deprovisioning, setDeprovisioning] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [ping, setPing]                   = useState<PingResult | null>(null);
  const [pinging, setPinging]             = useState(false);
  const [syncing, setSyncing]             = useState(false);
  const [dumping, setDumping]             = useState(false);

  const checkConnection = useCallback(async () => {
    setPinging(true);
    try {
      const res = await apiFetch('/ping', {}, 10_000, projectId);
      setPing(res);
    } catch (err) {
      setPing({ connected: false, error: (err as Error).message });
    } finally {
      setPinging(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/status', {}, 10_000, projectId);
      setDb(res.database);
      if (res.database?.status === 'active') {
        const t = await apiFetch('/tables', {}, 10_000, projectId).catch(() => ({ tables: [] }));
        setTables(t.tables || []);
        checkConnection();
      }
    } catch { /* server not configured yet */ }
    finally { setLoading(false); }
  }, [checkConnection]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await apiFetch('/sync-secrets', { method: 'POST' }, 20_000, projectId);
      await loadStatus();
      queryClient.invalidateQueries({ queryKey: ["project-secrets", projectId] });
      toast.success(`Synced ${res.synced ?? 0} secret(s) to the live preview${res.restarted ? ' (preview restarted)' : ''}`);
    } catch (err) { toast.error((err as Error).message); }
    finally { setSyncing(false); }
  };

  const handleDump = async () => {
    setDumping(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const res = await fetch(getApiServerUrl('/api/v1/database/dump'), {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Dump failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${db?.schema_name || 'database'}-dump-${Date.now()}.sql`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Database dump downloaded");
    } catch (err) { toast.error((err as Error).message); }
    finally { setDumping(false); }
  };

  const refreshTables = async () => {
    setTablesLoading(true);
    try {
      const t = await apiFetch('/tables', {}, 10_000, projectId);
      setTables(t.tables || []);
    } finally { setTablesLoading(false); }
  };

  const handleProvision = async () => {
    setProvisioning(true);
    try {
      const res = await apiFetch('/provision', {
        method: 'POST', body: JSON.stringify({ organization_id: currentOrganizationId || null }),
      }, 30_000, projectId);
      setDb(res.database);
      // Push the new credentials to the live preview immediately   without this
      // the app keeps hitting "Database API URL is not configured" until the
      // owner separately clicks Sync.
      await apiFetch('/sync-secrets', { method: 'POST' }, 20_000, projectId).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ["project-secrets", projectId] });
      toast.success("Database provisioned!");
    } catch (err) { toast.error((err as Error).message); }
    finally { setProvisioning(false); }
  };

  const handleDeprovision = async () => {
    setDeprovisioning(true);
    try {
      await apiFetch('/deprovision', { method: 'DELETE' }, 60_000, projectId);
      setDb(null); setTables([]); setSelectedTable(null);
      toast.success("Database removed.");
    } catch (err) { toast.error((err as Error).message); }
    finally { setDeprovisioning(false); }
  };

  // ── Free plan gate ──────────────────────────────────────────────────────
  if (!isPaid) return (
    <div className="space-y-6 w-full max-w-full overflow-hidden">
      <div>
        <h2 className="text-xl font-semibold mb-1">ECG CLOUD DB</h2>
        <p className="text-sm text-white/45">Dedicated PostgreSQL database with REST API and agent access</p>
      </div>
      <Card className="bg-workspace-surface border-indigo-500/25">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Pro or Agency plan required</CardTitle>
          </div>
          <CardDescription>
            Get a dedicated schema with REST API, schema browser, SQL editor, and full AI agent access. Zero setup   instant connection string.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" size="sm" onClick={() => window.open('/dashboard/settings?section=workspace-plans', '_self')}>
            Manage Billing
          </Button>
        </CardContent>
      </Card>
    </div>
  );

  if (loading) return (
    <div className="space-y-6 w-full max-w-full overflow-hidden animate-pulse">
      {/* Header skeleton */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="space-y-2 min-w-0">
          <div className="h-7 w-48 bg-white/[0.04] rounded-lg" />
          <div className="flex items-center gap-2">
            <div className="h-5 w-36 bg-white/[0.04] rounded-md" />
            <div className="h-5 w-16 bg-white/[0.04] rounded-full" />
            <div className="h-5 w-24 bg-white/[0.04] rounded-full" />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-8 w-20 bg-white/[0.04] rounded-md" />
          <div className="h-8 w-20 bg-white/[0.04] rounded-md" />
          <div className="h-8 w-16 bg-white/[0.04] rounded-md" />
        </div>
      </div>

      {/* Tabs skeleton */}
      <div className="h-10 w-full bg-white/[0.04] rounded-lg" />

      {/* Credentials cards skeleton */}
      <div className="space-y-3">
        <div className="h-4 w-72 bg-white/[0.04] rounded" />
        {[1,2,3,4,5].map(i => (
          <div key={i} className="rounded-lg border border-white/[0.07] bg-white/[0.03] p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="h-3 w-20 bg-white/[0.04] rounded" />
              <div className="h-3 w-10 bg-white/[0.04] rounded" />
            </div>
            <div className="h-4 w-full bg-white/[0.04] rounded" />
          </div>
        ))}
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-2">
          <div className="h-3 w-24 bg-blue-500/20 rounded" />
          <div className="h-16 w-full bg-blue-500/10 rounded" />
        </div>
      </div>
    </div>
  );

  // ── No DB yet ───────────────────────────────────────────────────────────
  if (!db) return (
    <div className="w-full max-w-full overflow-hidden">
      <div className="mb-5">
        <h2 className="text-xl font-semibold mb-1">ECG CLOUD DB</h2>
        <p className="text-sm text-white/30">Isolated PostgreSQL schema with REST API and AI agent access</p>
      </div>
      <div className="rounded-xl border border-white/[0.07] bg-workspace-surface p-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Database className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white/85">No database yet</p>
            <p className="text-xs text-white/30 truncate">Click to provision your dedicated schema</p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={handleProvision}
          disabled={provisioning}
          className="shrink-0 gap-1.5"
        >
          <Zap className="h-3.5 w-3.5" />
          {provisioning ? "Provisioning…" : "Provision"}
        </Button>
      </div>
    </div>
  );

  // ── Error state ─────────────────────────────────────────────────────────
  if (db.status === 'error') return (
    <div className="space-y-6 w-full max-w-full overflow-hidden">
      <div><h2 className="text-xl font-semibold mb-1">ECG CLOUD DB</h2></div>
      <Card className="bg-workspace-surface border-red-500/25">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-400" />
            <CardTitle className="text-base text-red-400">Provisioning failed</CardTitle>
          </div>
          <CardDescription className="text-red-400/70">{db.error_message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="w-full" onClick={handleProvision} disabled={provisioning}>
            {provisioning ? "Retrying…" : "Retry"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );

  // ── Active DB ───────────────────────────────────────────────────────────
  const activeTable = selectedTable ? tables.find(t => t.name === selectedTable) : null;

  return (
    <div className="space-y-6 w-full max-w-full overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold mb-1">ECG CLOUD DB</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-xs text-white/45 font-mono bg-white/[0.04] px-2 py-0.5 rounded truncate max-w-[200px]">{db.schema_name}</code>
            <StatusBadge status={db.status} />
            <ConnectionBadge ping={ping} checking={pinging} />
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", syncing && "animate-spin")} />
            {syncing ? "Syncing…" : "Sync"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleDump} disabled={dumping || db.status !== 'active'}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            {dumping ? "Dumping…" : "Dump"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
            disabled={deprovisioning}
            onClick={() => { setDeleteConfirmText(''); setDeleteDialogOpen(true); }}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            {deprovisioning ? "Removing…" : "Delete"}
          </Button>

          <Dialog open={deleteDialogOpen} onOpenChange={(o) => { if (!deprovisioning) { setDeleteDialogOpen(o); setDeleteConfirmText(''); } }}>
            <DialogContent className="bg-workspace-surface border-white/10 max-w-md">
              <DialogHeader>
                <DialogTitle className="text-white flex items-center gap-2">
                  <Trash2 className="h-4 w-4 text-red-400" />
                  Delete database
                </DialogTitle>
                <DialogDescription className="text-white/60">
                  This permanently deletes <span className="font-mono text-white/75">{db.schema_name}</span> and all its data. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-1">
                <p className="text-xs text-white/60">
                  Type <span className="font-mono text-white/80 bg-white/[0.06] px-1.5 py-0.5 rounded">delete my database</span> to confirm.
                </p>
                <Input
                  value={deleteConfirmText}
                  onChange={e => setDeleteConfirmText(e.target.value)}
                  placeholder="delete my database"
                  className="bg-white/[0.04] border-white/[0.07] text-white placeholder:text-white/30 font-mono text-sm"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && deleteConfirmText.trim().toLowerCase() === 'delete my database' && !deprovisioning) {
                      setDeleteDialogOpen(false);
                      handleDeprovision();
                    }
                  }}
                  autoFocus
                />
              </div>
              <DialogFooter className="gap-2">
                <Button variant="ghost" onClick={() => { setDeleteDialogOpen(false); setDeleteConfirmText(''); }} disabled={deprovisioning} className="text-white/60">
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={deleteConfirmText.trim().toLowerCase() !== 'delete my database' || deprovisioning}
                  onClick={() => { if (deprovisioning) return; setDeleteDialogOpen(false); handleDeprovision(); }}
                >
                  {deprovisioning ? "Removing…" : "Delete permanently"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* DB Info */}
      <DbInfoPanel schemaName={db.schema_name} />

      {/* Tabs */}
      <Tabs defaultValue="tables">
        <TabsList className="w-full grid grid-cols-2">
          <TabsTrigger value="tables" className="flex items-center gap-1.5">
            <Table className="h-3.5 w-3.5" />Tables
          </TabsTrigger>
          <TabsTrigger value="sql" className="flex items-center gap-1.5">
            <Terminal className="h-3.5 w-3.5" />SQL
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tables" className="mt-4">
          {activeTable ? (
            <div className="space-y-3">
              <button onClick={() => setSelectedTable(null)} className="text-xs text-white/45 hover:text-white/85 flex items-center gap-1 transition-colors duration-smooth">
                ← Back to tables
              </button>
              <h3 className="font-mono text-sm font-medium">{activeTable.name}</h3>
              <TableViewer tableName={activeTable.name} projectId={projectId} />
            </div>
          ) : (
            <SchemaBrowser
              tables={tables}
              loading={tablesLoading}
              onRefresh={refreshTables}
              onSelectTable={t => setSelectedTable(t.name)}
              selectedTable={selectedTable}
            />
          )}
        </TabsContent>

        <TabsContent value="sql" className="mt-4">
          <SqlEditor projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
};
