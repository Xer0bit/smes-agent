import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { Activity, AlertTriangle, Search, Timer } from 'lucide-react';
import {
  summarizeDelivery,
  groupStuckReasons,
  type AgentRunRow,
  type DeliveryHealth,
} from '@/services/deliveryHealth';

/**
 * Delivery health — did the agent's work actually reach the preview?
 *
 * Built only on agent_runs columns that are written on every run. Notably
 * absent: a promotion rate. `preview_promoted` carried DEFAULT false and no
 * writer until 2026-08-30, so charting it across historical rows would show a
 * permanent 0% and read as a total outage rather than a missing feed. It can
 * join this page once post-fix rows accumulate.
 */

const WINDOW = 500;

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function Stat({ icon: Icon, label, value, sub, tone }: {
  icon: typeof Activity; label: string; value: string; sub?: string;
  tone?: 'neutral' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'bad' ? 'text-red-400' : tone === 'warn' ? 'text-amber-400' : 'text-white/85';
  return (
    <div className="rounded-xl border border-white/[0.06] bg-[hsl(var(--admin-surface))] p-5 flex items-center gap-4">
      <div className="h-10 w-10 rounded-lg bg-white/[0.04] flex items-center justify-center shrink-0">
        <Icon className="h-5 w-5 text-white/50" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wider text-white/45 mb-0.5">{label}</p>
        <p className={`text-2xl font-bold ${toneClass}`}>{value}</p>
        {sub && <p className="text-[11px] text-white/35 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

export default function AdminDelivery() {
  const [rows, setRows] = useState<AgentRunRow[]>([]);
  const [health, setHealth] = useState<DeliveryHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('agent_runs')
      .select('status,duration_ms,estimated_cost_usd,edit_search_miss_count,stuck_abort_reason,preview_errors,created_at')
      .order('created_at', { ascending: false })
      .limit(WINDOW);

    if (err) {
      // Say what failed. A blank panel that looks like "no runs" is the same
      // silent-failure shape this page exists to expose.
      setError(err.message);
      setLoading(false);
      return;
    }
    const list = (data ?? []) as AgentRunRow[];
    setRows(list);
    setHealth(summarizeDelivery(list));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-white/40">Loading delivery health…</p>;

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/25 bg-red-500/[0.06] p-5">
        <p className="text-sm font-medium text-red-300">Couldn't load agent runs</p>
        <p className="text-xs text-white/50 mt-1">{error}</p>
        <button onClick={load} className="mt-3 text-xs text-white/70 underline hover:text-white">
          Try again
        </button>
      </div>
    );
  }

  if (!health || health.runs === 0) {
    return <p className="text-sm text-white/40">No agent runs recorded yet.</p>;
  }

  const stuck = groupStuckReasons(rows);
  const pct = (n: number) => `${Math.round((n / health.runs) * 100)}%`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white/90 mb-1">Delivery</h2>
        <p className="text-sm text-white/40">
          Last {health.runs} agent runs. Whether work reached the preview, and where it stalled.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Activity} label="Completed" value={`${Math.round(health.successRate * 100)}%`}
              sub={`${health.failed} failed`} tone={health.successRate < 0.9 ? 'warn' : 'neutral'} />
        <Stat icon={Timer} label="Duration p95" value={fmtDuration(health.durationP95Ms)}
              sub={`p50 ${fmtDuration(health.durationP50Ms)}`} />
        <Stat icon={AlertTriangle} label="Stuck-aborted" value={String(health.stuckAborted)}
              sub={pct(health.stuckAborted)} tone={health.stuckAborted > 0 ? 'warn' : 'neutral'} />
        <Stat icon={Search} label="Had search misses" value={String(health.withSearchMisses)}
              sub={pct(health.withSearchMisses)} tone={health.withSearchMisses > 0 ? 'warn' : 'neutral'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-white/[0.06] bg-[hsl(var(--admin-surface))] p-5">
          <p className="text-[11px] uppercase tracking-wider text-white/45 mb-3">Why runs stalled</p>
          {stuck.length === 0 ? (
            <p className="text-sm text-white/35">No stuck aborts in this window.</p>
          ) : (
            <ul className="space-y-2">
              {stuck.map((s) => (
                <li key={s.reason} className="flex items-start justify-between gap-4 text-sm">
                  <span className="text-white/65 leading-snug">{s.reason}</span>
                  <span className="tabular-nums font-semibold text-white/80 shrink-0">{s.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[hsl(var(--admin-surface))] p-5">
          <p className="text-[11px] uppercase tracking-wider text-white/45 mb-3">Cost and preview</p>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-white/50">Spend across window</dt>
              <dd className="tabular-nums text-white/80">${health.totalCostUsd.toFixed(2)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-white/50">Mean per run</dt>
              <dd className="tabular-nums text-white/80">${(health.totalCostUsd / health.runs).toFixed(3)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-white/50">Runs with preview errors</dt>
              <dd className="tabular-nums text-white/80">{health.withPreviewErrors} ({pct(health.withPreviewErrors)})</dd>
            </div>
          </dl>
          <p className="text-[11px] text-white/30 mt-4 leading-relaxed">
            Promotion rate is not shown yet: the column had no writer before 2026-08-30,
            so historical runs cannot be distinguished from failed pushes.
          </p>
        </div>
      </div>
    </div>
  );
}
