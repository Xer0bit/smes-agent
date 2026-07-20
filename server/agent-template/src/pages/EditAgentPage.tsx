import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, Plug, Database, Trash2, ArrowLeft } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';

const TIMEZONES = [
  'Pacific/Honolulu', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok',
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];

export default function EditAgentPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [overlay, setOverlay] = useState('');
  const [status, setStatus] = useState('active');
  const [selectedConnectorIds, setSelectedConnectorIds] = useState<string[]>([]);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);

  const [connectors, setConnectors] = useState<any[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<any[]>([]);

  useEffect(() => {
    if (!agentId) return;
    Promise.all([
      ecgApi.agents.get(agentId),
      ecgApi.connectors.list().then(d => Array.isArray(d) ? d : (d.connectors ?? [])),
      ecgApi.knowledgeBases.list().then(d => Array.isArray(d) ? d : (d.knowledgeBases ?? [])).catch(() => []),
    ])
      .then(([agent, c, kb]: any[]) => {
        setName(agent.name ?? '');
        setTimezone(agent.timezone ?? 'UTC');
        setOverlay(agent.prompt_overlay ?? agent.promptOverlay ?? '');
        setStatus(agent.status ?? 'active');
        setSelectedConnectorIds(agent.connector_ids ?? agent.connectorIds ?? []);
        setSelectedKbIds(agent.knowledge_base_ids ?? agent.knowledgeBaseIds ?? []);
        setConnectors(c);
        setKnowledgeBases(kb);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  function toggleConnector(id: string) {
    setSelectedConnectorIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }
  function toggleKb(id: string) {
    setSelectedKbIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function handleSave() {
    if (!agentId || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      // PATCH /agents/:id only accepts snake_case keys   no camelCase
      // fallback like POST has (see agents.ts's PATCH handler).
      await ecgApi.agents.update(agentId, {
        name: name.trim(),
        timezone,
        prompt_overlay: overlay,
        connector_ids: selectedConnectorIds,
        knowledge_base_ids: selectedKbIds,
      });
      navigate('/agents');
    } catch (e: any) {
      setError(e.message ?? 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!agentId) return;
    setDeleting(true);
    try {
      await ecgApi.agents.delete(agentId);
      navigate('/agents');
    } catch (e: any) {
      setError(e.message ?? 'Failed to delete agent');
      setDeleting(false);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--muted)' }} /></div>;
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5">
      <button onClick={() => navigate('/agents')} className="flex items-center gap-1.5 text-xs hover:opacity-70 transition-opacity" style={{ color: 'var(--muted)' }}>
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Agents
      </button>

      <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Edit Agent</h1>

      {error && <div className="text-sm px-4 py-2 rounded-lg bg-red-50 text-red-700">{error}</div>}

      <div className="rounded-xl border p-5 space-y-4" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text)' }}>Name</label>
          <input value={name} onChange={e => setName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border text-sm" style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text)' }}>Timezone</label>
          <select value={timezone} onChange={e => setTimezone(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border text-sm" style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}>
            {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text)' }}>Instructions</label>
          <textarea value={overlay} onChange={e => setOverlay(e.target.value)} rows={5}
            className="w-full px-3 py-2 rounded-lg border text-sm resize-none" style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text)' }}>Status</label>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Currently <span className="font-medium" style={{ color: 'var(--text)' }}>{status}</span>   change via the run/pause controls in Agents.</p>
        </div>
      </div>

      <div className="rounded-xl border p-5 space-y-3" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2">
          <Plug className="w-3.5 h-3.5" style={{ color: 'var(--muted)' }} />
          <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Connected Accounts</p>
        </div>
        {connectors.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>No accounts connected yet.</p>
        ) : (
          <div className="space-y-2">
            {connectors.map((c: any) => {
              const on = selectedConnectorIds.includes(c.id);
              return (
                <label key={c.id} className="flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer"
                  style={{ borderColor: 'var(--border)', background: on ? 'var(--accent-bg,#ede9fe)' : 'transparent' }}>
                  <input type="checkbox" checked={on} onChange={() => toggleConnector(c.id)} className="w-4 h-4" />
                  <span className="text-sm flex-1" style={{ color: 'var(--text)' }}>{c.name}</span>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>{c.type}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {knowledgeBases.length > 0 && (
        <div className="rounded-xl border p-5 space-y-3" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2">
            <Database className="w-3.5 h-3.5" style={{ color: 'var(--muted)' }} />
            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Knowledge Bases</p>
          </div>
          <div className="space-y-2">
            {knowledgeBases.map((kb: any) => {
              const on = selectedKbIds.includes(kb.id);
              return (
                <label key={kb.id} className="flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer"
                  style={{ borderColor: 'var(--border)', background: on ? 'var(--accent-bg,#ede9fe)' : 'transparent' }}>
                  <input type="checkbox" checked={on} onChange={() => toggleKb(kb.id)} className="w-4 h-4" />
                  <span className="text-sm" style={{ color: 'var(--text)' }}>{kb.name}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button onClick={() => setConfirmDelete(true)} className="flex items-center gap-1.5 text-xs text-red-600 hover:opacity-70 transition-opacity">
          <Trash2 className="w-3.5 h-3.5" /> Delete agent
        </button>
        <button onClick={handleSave} disabled={saving || !name.trim()}
          className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50" style={{ background: 'var(--accent)' }}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Delete Agent</h2>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Are you sure you want to delete <strong>{name}</strong>? This cannot be undone.
            </p>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setConfirmDelete(false)} disabled={deleting}
                className="flex-1 px-4 py-2 rounded-lg border text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                Cancel
              </button>
              <button onClick={handleDelete} disabled={deleting}
                className="flex-1 px-4 py-2 rounded-lg text-white text-sm bg-red-600 disabled:opacity-50">
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
