import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/adminClient';
import { toast } from 'sonner';
import { Page, Stats, Panel, Table, btn } from '@/components/admin/ui';
import { summarizeDelivery, groupStuckReasons, type AgentRunRow, type DeliveryHealth } from '@/services/deliveryHealth';

// preview_promoted is deliberately absent: no writer before 2026-08-30, so a
// historical promotion rate would read as a permanent 0% outage.
const WINDOW = 500;

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export default function AdminDelivery() {
  const [rows, setRows] = useState<AgentRunRow[]>([]);
  const [health, setHealth] = useState<DeliveryHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('agent_runs')
      .select('status,duration_ms,estimated_cost_usd,edit_search_miss_count,stuck_abort_reason,preview_errors,created_at')
      .order('created_at', { ascending: false })
      .limit(WINDOW);
    if (error) toast.error(error.message);
    const list = (data ?? []) as AgentRunRow[];
    setRows(list);
    setHealth(summarizeDelivery(list));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const stuck = groupStuckReasons(rows);
  const pct = (n: number) => (health && health.runs ? `${Math.round((n / health.runs) * 100)}%` : '0%');

  return (
    <Page title="Delivery" actions={<button className={btn.ghost} onClick={load} disabled={loading}>Refresh</button>}>
      {loading || !health ? (
        <p className="text-[13px] text-gray-500">Loading…</p>
      ) : (
        <>
          <Stats items={[
            { label: `Completed (${health.runs} runs)`, value: `${Math.round(health.successRate * 100)}%`, tone: health.successRate < 0.9 ? 'warn' : undefined },
            { label: 'Failed', value: health.failed, tone: health.failed > 0 ? 'bad' : undefined },
            { label: 'Duration p50 / p95', value: `${fmtDuration(health.durationP50Ms)} / ${fmtDuration(health.durationP95Ms)}` },
            { label: 'Stuck-aborted', value: `${health.stuckAborted} (${pct(health.stuckAborted)})`, tone: health.stuckAborted > 0 ? 'warn' : undefined },
            { label: 'Search misses', value: `${health.withSearchMisses} (${pct(health.withSearchMisses)})`, tone: health.withSearchMisses > 0 ? 'warn' : undefined },
            { label: 'Preview errors', value: `${health.withPreviewErrors} (${pct(health.withPreviewErrors)})`, tone: health.withPreviewErrors > 0 ? 'warn' : undefined },
            { label: 'Spend', value: `$${health.totalCostUsd.toFixed(2)}` },
            { label: 'Mean per run', value: `$${(health.runs ? health.totalCostUsd / health.runs : 0).toFixed(3)}` },
          ]} />
          <Panel title="Stuck reasons">
            <Table head={['Reason', 'Runs']} empty="No stuck aborts">
              {stuck.map((s) => (
                <tr key={s.reason}>
                  <td>{s.reason}</td>
                  <td className="tabular-nums">{s.count}</td>
                </tr>
              ))}
            </Table>
          </Panel>
        </>
      )}
    </Page>
  );
}
