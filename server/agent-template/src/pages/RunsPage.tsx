import { useEffect, useState } from 'react';
import { History, ChevronDown, ChevronUp } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';
import StatusBadge from '../components/StatusBadge';
import { PageHeader, Card, EmptyState, SkeletonRows } from '../components/ui';

const showDuration = (ECG.moduleSettings.runs?.showDuration ?? true) !== false;

function dur(start: string, end?: string) {
  const ms = new Date(end ?? Date.now()).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

const STATUS_DOT: Record<string, string> = {
  completed: '#16a34a', success: '#16a34a',
  failed: '#dc2626', error: '#dc2626', timeout: '#dc2626',
  running: 'var(--accent)',
};

export default function RunsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    ecgApi.runs.list()
      .then(d => setRows(Array.isArray(d) ? d : (d.runs ?? [])))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <PageHeader eyebrow="System" title="Run History" />
      {loading && <SkeletonRows count={5} />}
      {!loading && !rows.length && (
        <EmptyState Icon={History} title="No runs recorded yet"
          hint="Runs appear here every time an agent executes, whether scheduled or triggered manually." />
      )}
      {!loading && rows.length > 0 && (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                {['Agent', 'Status', ...(showDuration ? ['Duration'] : []), 'Started', ''].map((h, i) => (
                  <th key={i} className="text-left px-4 py-3 font-semibold uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any) => {
                const error = r.error ?? r.errorMessage ?? r.error_message ?? null;
                const isOpen = expanded === r.id;
                const dot = STATUS_DOT[(r.status ?? '').toLowerCase()] ?? 'var(--muted)';
                return [
                  <tr key={r.id} className={`border-b last:border-0 ${error ? 'cursor-pointer' : ''}`}
                    style={{ borderColor: 'var(--border)' }}
                    onClick={() => error && setExpanded(isOpen ? null : r.id)}>
                    <td className="px-4 py-3 font-medium" style={{ color: 'var(--text)' }}>
                      <span className="inline-flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
                        {r.agentName ?? r.agent_name ?? ' '}
                      </span>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                    {showDuration && (
                      <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--muted)' }}>{dur(r.startedAt ?? r.started_at, r.completedAt ?? r.completed_at)}</td>
                    )}
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--muted)' }}>{new Date(r.startedAt ?? r.started_at).toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">
                      {error && (isOpen
                        ? <ChevronUp className="w-3.5 h-3.5 inline" style={{ color: 'var(--muted)' }} />
                        : <ChevronDown className="w-3.5 h-3.5 inline" style={{ color: 'var(--muted)' }} />)}
                    </td>
                  </tr>,
                  isOpen && error ? (
                    <tr key={`${r.id}-detail`} className="border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                      <td colSpan={showDuration ? 5 : 4} className="px-4 pb-3 pt-0">
                        <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(220,38,38,0.08)', color: '#dc2626' }}>
                          {error}
                        </div>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
