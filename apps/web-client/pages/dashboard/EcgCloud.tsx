/**
 * Dashboard → eCG Cloud: every hosted database in the active workspace.
 *
 * Left: the list (project, schema, status) plus projects that have none yet.
 * Right: the full console for the selected project (status, schema browser,
 * SQL editor, provision / remove), which is the same component project
 * settings uses. The plan strip on top shows databases in use against the
 * plan so the "Add one" path is one click away.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Database, RefreshCw, Plus, AlertCircle, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DashboardPageHeader } from '@/components/dashboard/DashboardPageHeader';
import { DatabaseSettings } from '@/components/referral/settings/DatabaseSettings';
import { useOrganization } from '@/contexts/OrganizationContext';
import { fetchWorkspaceDatabases, type WorkspaceDatabase } from '@/services/cloudService';
import { fetchPlan, formatDollars, type PlanSnapshot } from '@/services/planService';
import { cn } from '@/lib/utils';

const STATUS_CLASS: Record<string, string> = {
  active: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  provisioning: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  deprovisioning: 'border-border text-muted-foreground',
  error: 'border-destructive/40 text-destructive',
};

function StatusBadge({ status }: { status: string }) {
  return <Badge variant="outline" className={cn('rounded-full text-[10px] capitalize', STATUS_CLASS[status] ?? 'border-border text-muted-foreground')}>{status}</Badge>;
}

export default function EcgCloud() {
  const { currentOrganizationId } = useOrganization();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('project');

  const [databases, setDatabases] = useState<WorkspaceDatabase[]>([]);
  const [withoutDb, setWithoutDb] = useState<Array<{ id: string; name: string }>>([]);
  const [plan, setPlan] = useState<PlanSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrganizationId) return;
    setLoading(true);
    try {
      const [list, snapshot] = await Promise.all([
        fetchWorkspaceDatabases(currentOrganizationId),
        fetchPlan(currentOrganizationId).catch(() => null),
      ]);
      setDatabases(list.databases);
      setWithoutDb(list.projects_without_database);
      setPlan(snapshot);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load databases');
    } finally {
      setLoading(false);
    }
  }, [currentOrganizationId]);

  useEffect(() => { void load(); }, [load]);

  // The console provisions and removes on its own; keep the list in step while one is open.
  useEffect(() => {
    if (!selected) return;
    const id = window.setInterval(() => { void load(); }, 15000);
    return () => window.clearInterval(id);
  }, [selected, load]);

  const select = (projectId: string | null) => {
    if (projectId) setSearchParams({ project: projectId }, { replace: true });
    else setSearchParams({}, { replace: true });
  };

  const selectedName = useMemo(() => {
    const db = databases.find((d) => d.project_id === selected);
    if (db) return db.project_name;
    return withoutDb.find((p) => p.id === selected)?.name ?? null;
  }, [databases, withoutDb, selected]);

  if (!currentOrganizationId) {
    return (
      <div className="p-6 sm:p-8">
        <DashboardPageHeader title="eCG Cloud" description="Select a workspace from the sidebar to see its databases." />
      </div>
    );
  }

  const used = plan?.usage.databases ?? databases.filter((d) => d.status === 'active').length;
  const bought = plan?.entitlements.databases;

  return (
    <div className="p-6 sm:p-8">
      <DashboardPageHeader
        title="eCG Cloud"
        description="Hosted databases for this workspace. Browse schemas, run SQL, and provision new ones."
        actions={
          <Button variant="outline" size="sm" className="rounded-full" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />Refresh
          </Button>
        }
      />

      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-none border border-border/60 px-5 py-3">
        <div className="flex items-center gap-3 text-sm">
          <Database className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">Databases</span>
          <span className="tabular-nums text-muted-foreground">{used} in use{bought !== undefined ? ` of ${bought} on the plan` : ''}</span>
          {bought !== undefined && used >= bought && <Badge variant="outline" className="rounded-full text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400">Full</Badge>}
        </div>
        <div className="flex items-center gap-3 text-sm">
          {plan && <span className="text-muted-foreground tabular-nums">{formatDollars(plan.estimate.total_cents)}/mo</span>}
          <button type="button" className="text-primary hover:underline" onClick={() => navigate('/dashboard/organizations?tab=billing')}>
            {bought !== undefined && used >= bought ? 'Add a database' : 'Manage plan'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-none border border-destructive/30 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />{error}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)] items-start">
        <aside className="space-y-5">
          <div>
            <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provisioned</p>
            {loading && databases.length === 0 ? (
              <div className="space-y-2"><div className="skeleton h-16 rounded-none" /><div className="skeleton h-16 rounded-none" /></div>
            ) : databases.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">No databases yet. Pick a project below to provision one.</p>
            ) : (
              <ul className="space-y-2">
                {databases.map((db) => (
                  <li key={db.id}>
                    <button
                      type="button"
                      onClick={() => select(db.project_id)}
                      className={cn(
                        'w-full rounded-none border px-4 py-3 text-left transition-colors',
                        selected === db.project_id ? 'border-primary/50 bg-primary/5' : 'border-border/60 hover:bg-muted/40',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium truncate">{db.project_name}</span>
                        <StatusBadge status={db.status} />
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="font-mono truncate">{db.schema_name}</span>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      </div>
                      {db.status === 'error' && db.error_message && (
                        <p className="mt-1 text-xs text-destructive truncate">{db.error_message}</p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {withoutDb.length > 0 && (
            <div>
              <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Projects without a database</p>
              <ul className="space-y-2">
                {withoutDb.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => select(p.id)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-none border border-dashed px-4 py-3 text-left transition-colors',
                        selected === p.id ? 'border-primary/50 bg-primary/5' : 'border-border/60 hover:bg-muted/40',
                      )}
                    >
                      <span className="text-sm truncate">{p.name}</span>
                      <span className="inline-flex items-center gap-1 text-xs text-primary"><Plus className="h-3.5 w-3.5" />Provision</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <section className="min-w-0">
          {selected ? (
            <div className="rounded-none border border-border/60 overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{selectedName ?? 'Project'}</p>
                  <p className="text-xs text-muted-foreground">Database console</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => select(null)}>Close</Button>
              </div>
              {/* The console was built on the editor's dark surfaces; scope it dark so it reads the same here. */}
              <div className="dark bg-background text-foreground p-5">
                <DatabaseSettings key={selected} projectId={selected} organizationId={currentOrganizationId} onChange={load} />
              </div>
            </div>
          ) : (
            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-none border border-dashed border-border/60 text-center">
              <Database className="h-8 w-8 text-muted-foreground mb-3" />
              <p className="text-sm font-medium">Select a database</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">Open a project's database to browse tables, run SQL, and see its status. Projects without one can be provisioned from the list.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
