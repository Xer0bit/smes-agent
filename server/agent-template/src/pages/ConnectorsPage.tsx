import { useEffect, useState } from 'react';
import { Plug } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

export default function ConnectorsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ecgApi.connectors.list()
      .then(d => setRows(Array.isArray(d) ? d : (d.connectors ?? [])))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Connectors</h1>
      {loading && <Spinner />}
      {!loading && !rows.length && <div className="text-center py-16 text-sm" style={{ color: 'var(--muted)' }}>No connectors configured</div>}
      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {rows.map((c: any) => (
            <div key={c.id} className="rounded-xl border p-5" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--border)' }}>
                  <Plug className="w-4 h-4" style={{ color: 'var(--muted)' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-sm truncate" style={{ color: 'var(--text)' }}>{c.name}</p>
                    <StatusBadge status={c.status ?? 'active'} />
                  </div>
                  <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--muted)' }}>{c.type}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Spinner() { return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
