import { useEffect, useState } from 'react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

export default function SchedulersPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ecgApi.schedulers.list()
      .then(d => setRows(Array.isArray(d) ? d : (d.schedulers ?? [])))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Schedulers</h1>
      {loading && <Spinner />}
      {!loading && !rows.length && <Empty />}
      {!loading && rows.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                {['Agent', 'Schedule', 'Next Run', 'Status'].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-semibold uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {rows.map((s: any) => (
                <tr key={s.id}>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--text)' }}>{s.agentName ?? s.agent_name ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--muted)' }}>{s.schedule ?? s.cron}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--muted)' }}>{s.nextRun ? new Date(s.nextRun).toLocaleString() : '—'}</td>
                  <td className="px-4 py-3"><StatusBadge status={s.status ?? 'active'} /></td>
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
function Empty() { return <div className="text-center py-16 text-sm" style={{ color: 'var(--muted)' }}>No schedulers configured</div>; }
