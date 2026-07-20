import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, X, Play, Send, Loader2, AlertTriangle } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';
import StatusBadge from '../components/StatusBadge';

const showNextRun = (ECG.moduleSettings.schedulers?.showNextRun ?? true) !== false;

const DAYS_OF_WEEK = [
  { label: 'Mon', value: '1' }, { label: 'Tue', value: '2' }, { label: 'Wed', value: '3' },
  { label: 'Thu', value: '4' }, { label: 'Fri', value: '5' }, { label: 'Sat', value: '6' }, { label: 'Sun', value: '0' },
];
function buildWeeklyCron(days: string[], hour: number): string {
  const sorted = [...days].sort((a, b) => Number(a) - Number(b));
  return `0 ${hour} * * ${sorted.join(',')}`;
}

export default function SchedulersPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [connectors, setConnectors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletingScheduler, setDeletingScheduler] = useState<any>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [replanMsg, setReplanMsg] = useState('');

  function load() {
    setLoading(true);
    Promise.all([
      ecgApi.schedulers.list().then(d => Array.isArray(d) ? d : (d.schedulers ?? [])),
      ecgApi.agents.list().then(d => Array.isArray(d) ? d : (d.agents ?? [])),
      ecgApi.connectors.list().then(d => Array.isArray(d) ? d : (d.connectors ?? [])),
    ])
      .then(([schedulersData, agentsData, connectorsData]) => {
        setRows(schedulersData);
        setAgents(agentsData);
        setConnectors(connectorsData.filter((c: any) => (c.status ?? '').toLowerCase() === 'connected' || (c.status ?? '').toLowerCase() === 'active'));
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  const handleDelete = async () => {
    if (!deletingScheduler?.id) return;
    setModalLoading(true);
    try {
      await ecgApi.schedulers.delete(deletingScheduler.id);
      setRows(rows.filter(r => r.id !== deletingScheduler.id));
      setDeletingScheduler(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setModalLoading(false);
    }
  };

  const handleToggle = async (id: string, status: string) => {
    try {
      const next = status === 'active' ? 'paused' : 'active';
      const updated = await ecgApi.schedulers.update(id, { status: next });
      setRows(rows.map(r => r.id === id ? { ...r, ...updated } : r));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleTrigger = async (id: string) => {
    setTriggeringId(id);
    setReplanMsg('');
    try {
      await ecgApi.schedulers.trigger(id);
      setReplanMsg('Posts are being generated — check Planned Posts in a moment.');
      setTimeout(() => setReplanMsg(''), 5000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTriggeringId(null);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Schedulers</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ background: 'var(--accent)' }}
        >
          <Plus className="w-4 h-4" /> New Scheduler
        </button>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}
      {replanMsg && <div className="text-sm px-4 py-3 rounded-lg" style={{ background: 'var(--accent-bg,#ede9fe)', color: 'var(--text)' }}>{replanMsg}</div>}

      {loading && <Spinner />}
      {!loading && !rows.length && <Empty />}
      {!loading && rows.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                {['Agent', 'Schedule', ...(showNextRun ? ['Next Run'] : []), 'Status', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-semibold uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {rows.map((s: any) => (
                <tr key={s.id}>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--text)' }}>{s.agentName ?? s.agent_name ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--muted)' }}>{s.schedule ?? s.cron}</td>
                  {showNextRun && (
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--muted)' }}>{s.nextRun ? new Date(s.nextRun).toLocaleString() : '—'}</td>
                  )}
                  <td className="px-4 py-3"><StatusBadge status={s.status ?? 'active'} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleTrigger(s.id)}
                        disabled={triggeringId === s.id}
                        className="p-1 rounded hover:bg-gray-100 disabled:opacity-50"
                        title="Generate posts now"
                      >
                        {triggeringId === s.id ? <Loader2 className="w-4 h-4 animate-spin text-green-600" /> : <Send className="w-4 h-4 text-green-600" />}
                      </button>
                      <button
                        onClick={() => handleToggle(s.id, s.status)}
                        className="p-1 rounded hover:bg-gray-100"
                        title={s.status === 'active' ? 'Pause' : 'Resume'}
                      >
                        {s.status === 'active' ? <Pencil className="w-4 h-4 text-gray-600" /> : <Play className="w-4 h-4 text-gray-600" />}
                      </button>
                      <button
                        onClick={() => setDeletingScheduler(s)}
                        className="p-1 rounded hover:bg-red-50"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4 text-red-600" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateSchedulerModal
          agents={agents}
          connectors={connectors}
          onClose={() => setShowCreate(false)}
          onCreated={(created) => { setRows([...rows, created]); setShowCreate(false); }}
        />
      )}

      {deletingScheduler && (
        <DeleteConfirmModal
          itemName={`scheduler for ${deletingScheduler.agentName ?? deletingScheduler.agent_name ?? 'Unknown'}`}
          onClose={() => setDeletingScheduler(null)}
          onConfirm={handleDelete}
          loading={modalLoading}
        />
      )}
    </div>
  );
}

function Spinner() { return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
function Empty() { return <div className="text-center py-16 text-sm" style={{ color: 'var(--muted)' }}>No schedulers configured</div>; }

function CreateSchedulerModal({ agents, connectors, onClose, onCreated }: {
  agents: any[]; connectors: any[]; onClose: () => void; onCreated: (created: any) => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [connectorId, setConnectorId] = useState('');
  const [daysOfWeek, setDaysOfWeek] = useState<string[]>(['3']);
  const [startHour, setStartHour] = useState(9);
  const [postCount, setPostCount] = useState(3);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const connectorType = connectors.find(c => c.id === connectorId)?.type ?? '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agentId || !connectorId || !connectorType || daysOfWeek.length === 0) {
      setError('Agent, connector, and at least one day are required.');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const created = await ecgApi.schedulers.create({
        agentId,
        connector: connectorType,
        cron: buildWeeklyCron(daysOfWeek, startHour),
        postCount,
      });
      onCreated(created);
    } catch (e: any) {
      setError(e.message ?? 'Failed to create scheduler');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto" style={{ background: 'var(--card-bg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>New Scheduler</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Agent</label>
            <select value={agentId} onChange={e => setAgentId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-sm" style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }} required>
              <option value="">Select agent...</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Connector</label>
            {connectors.length === 0 ? (
              <p className="text-xs flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> No connected accounts — connect one in Connectors first.
              </p>
            ) : (
              <select value={connectorId} onChange={e => setConnectorId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }} required>
                <option value="">Select connector...</option>
                {connectors.map(c => <option key={c.id} value={c.id}>{c.name} ({c.type})</option>)}
              </select>
            )}
          </div>

          <div>
            <p className="text-xs font-medium mb-1.5" style={{ color: 'var(--text)' }}>Days of week</p>
            <div className="flex flex-wrap gap-1.5">
              {DAYS_OF_WEEK.map(d => {
                const on = daysOfWeek.includes(d.value);
                return (
                  <button key={d.value} type="button"
                    onClick={() => setDaysOfWeek(prev => on ? prev.filter(v => v !== d.value) : [...prev, d.value])}
                    className="text-xs px-3 py-1.5 rounded-lg border transition-colors"
                    style={on ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : { borderColor: 'var(--border)', color: 'var(--text)' }}>
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text)' }}>Earliest post time</label>
            <select value={startHour} onChange={e => setStartHour(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg border text-sm" style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text)' }}>Posts per run</label>
              <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>{postCount}</span>
            </div>
            <input type="range" min={1} max={10} value={postCount} onChange={e => setPostCount(Number(e.target.value))} className="w-full" />
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 rounded-lg border text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>Cancel</button>
            <button type="submit" disabled={creating}
              className="flex-1 px-4 py-2 rounded-lg text-white text-sm disabled:opacity-50" style={{ background: 'var(--accent)' }}>
              {creating ? 'Creating...' : 'Create Scheduler'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteConfirmModal({ itemName, onClose, onConfirm, loading }: {
  itemName: string;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Delete Scheduler</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Are you sure you want to delete <strong>{itemName}</strong>? This action cannot be undone.
        </p>
        <div className="flex gap-3 pt-2">
          <button onClick={onClose} disabled={loading} className="flex-1 px-4 py-2 rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>Cancel</button>
          <button onClick={onConfirm} disabled={loading} className="flex-1 px-4 py-2 rounded-lg text-white bg-red-600 disabled:opacity-50">
            {loading ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
