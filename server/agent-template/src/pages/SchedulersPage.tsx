import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, X, Play } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

export default function SchedulersPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingScheduler, setEditingScheduler] = useState<any>(null);
  const [deletingScheduler, setDeletingScheduler] = useState<any>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    Promise.all([
      ecgApi.schedulers.list().then(d => Array.isArray(d) ? d : (d.schedulers ?? [])),
      ecgApi.agents.list().then(d => Array.isArray(d) ? d : (d.agents ?? []))
    ])
      .then(([schedulersData, agentsData]) => {
        setRows(schedulersData);
        setAgents(agentsData);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (schedulerData: any) => {
    setModalLoading(true);
    try {
      if (editingScheduler?.id) {
        const updated = await ecgApi.schedulers.update(editingScheduler.id, schedulerData);
        setRows(rows.map(r => r.id === editingScheduler.id ? { ...r, ...updated } : r));
      } else {
        const created = await ecgApi.schedulers.create(schedulerData);
        setRows([...rows, created]);
      }
      setEditingScheduler(null);
      setShowCreate(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setModalLoading(false);
    }
  };

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

  const handleTrigger = async (schedulerId: string) => {
    try {
      await ecgApi.schedulers.trigger(schedulerId);
    } catch (e: any) {
      setError(e.message);
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

      {loading && <Spinner />}
      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}
      {!loading && !rows.length && <Empty />}
      {!loading && rows.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--border)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                {['Agent', 'Schedule', 'Next Run', 'Status', 'Actions'].map(h => (
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
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleTrigger(s.id)}
                        className="p-1 rounded hover:bg-gray-100"
                        title="Trigger now"
                      >
                        <Play className="w-4 h-4 text-green-600" />
                      </button>
                      <button
                        onClick={() => setEditingScheduler(s)}
                        className="p-1 rounded hover:bg-gray-100"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4 text-gray-600" />
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

      {(showCreate || editingScheduler) && (
        <SchedulerModal
          scheduler={editingScheduler}
          agents={agents}
          onClose={() => {
            setShowCreate(false);
            setEditingScheduler(null);
          }}
          onSave={handleSave}
          loading={modalLoading}
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

function SchedulerModal({ scheduler, agents, onClose, onSave, loading }: {
  scheduler: any;
  agents: any[];
  onClose: () => void;
  onSave: (data: any) => void;
  loading: boolean;
}) {
  const [agentId, setAgentId] = useState(scheduler?.agentId ?? scheduler?.agent_id ?? '');
  const [schedule, setSchedule] = useState(scheduler?.schedule ?? scheduler?.cron ?? '');
  const [platforms, setPlatforms] = useState(scheduler?.platforms ?? []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId || !schedule.trim()) return;
    onSave({ agentId, schedule: schedule.trim(), platforms });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
            {scheduler ? 'Edit Scheduler' : 'New Scheduler'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Agent</label>
            <select
              value={agentId}
              onChange={e => setAgentId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              required
            >
              <option value="">Select agent...</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Schedule (cron)</label>
            <input
              type="text"
              value={schedule}
              onChange={e => setSchedule(e.target.value)}
              placeholder="0 9 * * *"
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              required
            />
            <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Format: minute hour day month weekday (e.g., 0 9 * * *)</p>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg border"
              style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !agentId || !schedule.trim()}
              className="flex-1 px-4 py-2 rounded-lg text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              {loading ? 'Saving...' : scheduler ? 'Save' : 'Create'}
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
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2 rounded-lg border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 px-4 py-2 rounded-lg text-white bg-red-600 disabled:opacity-50"
          >
            {loading ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
