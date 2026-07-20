import { useEffect, useState } from 'react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';
import StatusBadge from '../components/StatusBadge';

const showDuration = (ECG.moduleSettings.runs?.showDuration ?? true) !== false;

function dur(start: string, end?: string) {
  const ms = new Date(end ?? Date.now()).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

export default function RunsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ecgApi.runs.list()
      .then(d => setRows(Array.isArray(d) ? d : (d.runs ?? [])))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Run History</h1>
      {loading && <Spinner />}
      {!loading && !rows.length && <div className="text-center py-16 text-sm" style={{ color: 'var(--muted)' }}>No runs recorded yet</div>}
      {!loading && rows.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                {['Agent', 'Status', ...(showDuration ? ['Duration'] : []), 'Started'].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-semibold uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id} className="border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--text)' }}>{r.agentName ?? r.agent_name ?? '—'}</td>
                  <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                  {showDuration && (
                    <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--muted)' }}>{dur(r.startedAt ?? r.started_at, r.completedAt ?? r.completed_at)}</td>
                  )}
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--muted)' }}>{new Date(r.startedAt ?? r.started_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Spinner() { return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
