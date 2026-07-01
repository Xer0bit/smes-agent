import { useEffect, useState } from 'react';
import { Zap, Clock } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

export default function AgentsPage() {
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    ecgApi.agents.list()
      .then(d => setAgents(Array.isArray(d) ? d : (d.agents ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Agents</h1>
      {loading && <Spinner />}
      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}
      {!loading && !error && !agents.length && <Empty label="No agents found" />}
      {!loading && !error && agents.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agents.map((a: any) => (
            <div key={a.id} className="rounded-xl border p-5"
              style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: 'var(--accent-bg,#ede9fe)' }}>
                    <Zap className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                  </div>
                  <div>
                    <p className="font-semibold text-sm" style={{ color: 'var(--text)' }}>{a.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{a.templateName ?? a.template_name ?? '—'}</p>
                  </div>
                </div>
                <StatusBadge status={a.status} />
              </div>
              {(a.lastRun || a.last_run) && (
                <div className="mt-3 flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                  <Clock className="w-3 h-3" />
                  {new Date(a.lastRun ?? a.last_run).toLocaleString()}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Spinner() { return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
function Empty({ label }: { label: string }) { return <div className="text-center py-16 text-sm" style={{ color: 'var(--muted)' }}>{label}</div>; }
