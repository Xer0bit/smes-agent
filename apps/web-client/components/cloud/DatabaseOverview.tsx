/**
 * Supabase-style database overview: health, storage, security posture, per
 * table statistics, and the ERD. Server: GET /api/v1/database/overview.
 * Everything here comes from catalog and planner statistics, never from
 * tenant rows.
 */
import { useCallback, useEffect, useState } from 'react';
import { Activity, HardDrive, ShieldCheck, ShieldAlert, Table2, RefreshCw, Plug, Layers, KeyRound, Waypoints } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fetchDatabaseOverview, type DatabaseOverview as Overview } from '@/services/cloudService';
import { ErdDiagram } from './ErdDiagram';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function Stat({ icon: Icon, label, value, hint, tone }: { icon: typeof Activity; label: string; value: string; hint?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="rounded-xl border border-border/60 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Icon className={cn('h-4 w-4', tone === 'ok' ? 'text-emerald-500' : tone === 'warn' ? 'text-amber-500' : tone === 'bad' ? 'text-destructive' : 'text-muted-foreground')} />
      </div>
      <div className="mt-2 text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-24 rounded-xl" />)}</div>
      <div className="skeleton h-48 rounded-xl" />
    </div>
  );
}

export function DatabaseOverview({ projectId, view }: { projectId: string; view: 'health' | 'erd' }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchDatabaseOverview(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the overview');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <p className="py-6 text-sm text-destructive">{error}</p>;
  if (!data) return <Skeleton />;

  const { health, tables, relationships } = data;

  if (view === 'erd') {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{tables.length} table{tables.length === 1 ? '' : 's'} · {relationships.length} relationship{relationships.length === 1 ? '' : 's'}</p>
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}><RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />Refresh</Button>
        </div>
        <ErdDiagram tables={tables} edges={relationships} />
      </div>
    );
  }

  const unprotected = health.tables_without_policies.length;
  const rlsTone = health.tables === 0 ? undefined : health.rls_enabled_tables === health.tables ? 'ok' : 'bad';
  const deadPct = health.dead_tuple_ratio == null ? null : Math.round(health.dead_tuple_ratio * 100);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <span className={cn('inline-block h-2 w-2 rounded-full', health.connected ? 'bg-emerald-500' : 'bg-destructive')} />
          <span className="font-medium">{health.connected ? 'Healthy' : 'Unreachable'}</span>
          {health.server_version && <span className="text-muted-foreground">· PostgreSQL {health.server_version}</span>}
          <span className="font-mono text-xs text-muted-foreground">· {data.schema}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}><RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />Refresh</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Activity} label="Latency" value={health.latency_ms == null ? '—' : `${health.latency_ms} ms`} hint="Round trip from the API" tone={health.connected ? 'ok' : 'bad'} />
        <Stat icon={HardDrive} label="Storage" value={formatBytes(health.size_bytes)} hint={`${health.tables} tables · ${health.indexes} indexes`} />
        <Stat icon={Plug} label="Connections" value={String(health.connections)} hint="Open sessions from this database's roles" />
        <Stat
          icon={rlsTone === 'ok' ? ShieldCheck : ShieldAlert}
          label="Row level security"
          value={health.tables === 0 ? '—' : `${health.rls_enabled_tables}/${health.tables}`}
          hint={unprotected > 0 ? `${unprotected} table${unprotected === 1 ? '' : 's'} with no policy (deny all)` : `${health.policies} polic${health.policies === 1 ? 'y' : 'ies'}`}
          tone={rlsTone}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Layers} label="Objects" value={`${health.tables + health.views}`} hint={`${health.views} views · ${health.functions} functions · ${health.sequences} sequences · ${health.triggers} triggers`} />
        <Stat icon={KeyRound} label="Roles" value={`${[health.roles.anon, health.roles.service, health.roles.owner].filter(Boolean).length}/3`} hint={`anon ${health.roles.anon ? '✓' : '✗'} · service ${health.roles.service ? '✓' : '✗'} · owner ${health.roles.owner ? '✓' : '✗'}`} tone={health.roles.anon && health.roles.service && health.roles.owner ? 'ok' : 'bad'} />
        <Stat icon={Waypoints} label="REST API" value={health.api_exposed == null ? 'Unknown' : health.api_exposed ? 'Exposed' : 'Not exposed'} hint="Schema reachable through PostgREST" tone={health.api_exposed == null ? undefined : health.api_exposed ? 'ok' : 'warn'} />
        <Stat icon={Table2} label="Bloat" value={deadPct == null ? '—' : `${deadPct}%`} hint={health.last_analyze ? `Last analyze ${new Date(health.last_analyze).toLocaleString()}` : 'Not analyzed yet'} tone={deadPct == null ? undefined : deadPct > 20 ? 'warn' : 'ok'} />
      </div>

      <div className="rounded-xl border border-border/60 overflow-hidden">
        <div className="grid grid-cols-[minmax(0,1.6fr)_repeat(5,minmax(0,1fr))] gap-2 border-b border-border/60 bg-muted/40 px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <span>Table</span><span className="text-right">Rows (est.)</span><span className="text-right">Size</span><span className="text-right">Indexes</span><span className="text-right">Scans seq / idx</span><span className="text-right">Security</span>
        </div>
        {tables.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">No tables yet.</p>
        ) : tables.map((t) => (
          <div key={t.name} className="grid grid-cols-[minmax(0,1.6fr)_repeat(5,minmax(0,1fr))] gap-2 items-center border-b border-border/60 last:border-0 px-4 py-2.5 text-sm">
            <span className="font-mono truncate">{t.name}<span className="ml-2 text-xs text-muted-foreground">{t.columns.length} cols</span></span>
            <span className="text-right tabular-nums">{t.row_estimate.toLocaleString()}</span>
            <span className="text-right tabular-nums">{formatBytes(t.size_bytes)}</span>
            <span className="text-right tabular-nums">{t.index_count}</span>
            <span className="text-right tabular-nums text-muted-foreground">{t.seq_scans.toLocaleString()} / {t.idx_scans.toLocaleString()}</span>
            <span className="text-right">
              {!t.rls_enabled ? <Badge variant="outline" className="rounded-full text-[10px] border-destructive/40 text-destructive">RLS off</Badge>
                : t.policy_count === 0 ? <Badge variant="outline" className="rounded-full text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400">deny all</Badge>
                : <Badge variant="outline" className="rounded-full text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400">{t.policy_count} polic{t.policy_count === 1 ? 'y' : 'ies'}</Badge>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
