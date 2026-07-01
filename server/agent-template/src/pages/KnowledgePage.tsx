import { useEffect, useState } from 'react';
import { ecgApi } from '../lib/ecgClient';

const TYPE_ICONS: Record<string, string> = { document: '📄', url: '🔗', text: '📝' };

export default function KnowledgePage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ecgApi.knowledge.list()
      .then(d => setItems(Array.isArray(d) ? d : (d.knowledge ?? d.items ?? [])))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Knowledge</h1>
      {loading && <Spinner />}
      {!loading && !items.length && <div className="text-center py-16 text-sm" style={{ color: 'var(--muted)' }}>No knowledge assets found</div>}
      {!loading && items.length > 0 && (
        <div className="space-y-2">
          {items.map((k: any) => (
            <div key={k.id} className="rounded-xl border px-5 py-4 flex items-center gap-4"
              style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
              <span className="text-xl">{TYPE_ICONS[k.type] ?? '📄'}</span>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate" style={{ color: 'var(--text)' }}>{k.title ?? k.name ?? 'Untitled'}</p>
                <p className="text-xs mt-0.5 capitalize" style={{ color: 'var(--muted)' }}>{k.type ?? 'document'}</p>
              </div>
              {k.agentName && <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>{k.agentName}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Spinner() { return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
