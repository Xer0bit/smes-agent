import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Clock, Plus, Pencil, Trash2 } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';
import StatusBadge from '../components/StatusBadge';
import { PageHeader, Card, EmptyState, Spinner, relTime } from '../components/ui';

const showLastRun = (ECG.moduleSettings.agents?.showLastRun ?? true) !== false;

interface Agent {
  id: string;
  name: string;
  status: string;
  templateName?: string;
  template_name?: string;
  lastRun?: string;
  last_run?: string;
}

export default function AgentsPage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletingAgent, setDeletingAgent] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    ecgApi.agents.list()
      .then(d => setAgents(Array.isArray(d) ? d : (d.agents ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async () => {
    if (!deletingAgent?.id) return;
    setDeleting(true);
    try {
      await ecgApi.agents.delete(deletingAgent.id);
      setAgents(agents.filter(a => a.id !== deletingAgent.id));
      setDeletingAgent(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const handleRun = async (agentId: string) => {
    try {
      await ecgApi.agents.run(agentId);
      setAgents(agents.map(a => a.id === agentId ? { ...a, lastRun: new Date().toISOString() } : a));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <PageHeader eyebrow="Content" title="Agents" action={
        <button
          onClick={() => navigate('/agents/create')}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white hover:opacity-90"
          style={{ background: 'var(--accent)' }}
        >
          <Plus className="w-4 h-4" /> New Agent
        </button>
      } />

      {loading && <Spinner />}
      {error && <div className="text-sm rounded-lg px-4 py-3" style={{ color: '#dc2626', background: 'rgba(220,38,38,0.08)' }}>{error}</div>}
      {!loading && !error && !agents.length && (
        <EmptyState Icon={Zap} title="No agents yet"
          hint="An agent writes and schedules content for you. Create your first one to get started."
          action={
            <button onClick={() => navigate('/agents/create')}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white hover:opacity-90"
              style={{ background: 'var(--accent)' }}>
              <Plus className="w-4 h-4" /> Create agent
            </button>
          } />
      )}
      {!loading && !error && agents.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agents.map((a: Agent) => (
            <Card key={a.id} hover className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-white text-sm"
                    style={{ background: 'var(--accent)', fontWeight: 'var(--font-weight-heading)' }}>
                    {a.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate" style={{ color: 'var(--text)' }}>{a.name}</p>
                    <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{a.templateName ?? a.template_name ?? ' '}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <StatusBadge status={a.status} />
                  <button onClick={() => handleRun(a.id)} title="Run now"
                    className="p-1.5 rounded hover:bg-[var(--accent-bg)]">
                    <Zap className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                  </button>
                  <button onClick={() => navigate(`/agents/${a.id}/edit`)} title="Edit"
                    className="p-1.5 rounded hover:bg-[var(--accent-bg)]">
                    <Pencil className="w-4 h-4" style={{ color: 'var(--muted)' }} />
                  </button>
                  <button onClick={() => setDeletingAgent(a)} title="Delete"
                    className="p-1.5 rounded hover:bg-red-500/10">
                    <Trash2 className="w-4 h-4" style={{ color: '#dc2626' }} />
                  </button>
                </div>
              </div>
              {showLastRun && (a.lastRun || a.last_run) && (
                <div className="mt-3 flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                  <Clock className="w-3 h-3" />
                  Last run {relTime(a.lastRun ?? a.last_run)}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {deletingAgent && (
        <DeleteConfirmModal
          itemName={deletingAgent.name}
          onClose={() => setDeletingAgent(null)}
          onConfirm={handleDelete}
          loading={deleting}
        />
      )}
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
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Delete Agent</h2>
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
