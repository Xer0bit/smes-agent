import { useEffect, useState } from 'react';
import { Zap, Clock, Plus, Pencil, Trash2, X } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';

interface Agent {
  id: string;
  name: string;
  status: string;
  templateName?: string;
  template_name?: string;
  templateId?: string;
  template_id?: string;
  lastRun?: string;
  last_run?: string;
}

interface AgentTemplate {
  id: string;
  name: string;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<Agent | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    Promise.all([
      ecgApi.agents.list().then(d => Array.isArray(d) ? d : (d.agents ?? [])),
      ecgApi.templates.list().then(d => Array.isArray(d) ? d : [])
    ])
      .then(([agentsData, templatesData]) => {
        setAgents(agentsData);
        setTemplates(templatesData);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (agentData: Partial<Agent>) => {
    setModalLoading(true);
    try {
      if (editingAgent?.id) {
        const updated = await ecgApi.agents.update(editingAgent.id, agentData);
        setAgents(agents.map(a => a.id === editingAgent.id ? { ...a, ...updated } : a));
      } else {
        const created = await ecgApi.agents.create(agentData);
        setAgents([...agents, created]);
      }
      setEditingAgent(null);
      setShowCreate(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setModalLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingAgent?.id) return;
    setModalLoading(true);
    try {
      await ecgApi.agents.delete(deletingAgent.id);
      setAgents(agents.filter(a => a.id !== deletingAgent.id));
      setDeletingAgent(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setModalLoading(false);
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
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Agents</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ background: 'var(--accent)' }}
        >
          <Plus className="w-4 h-4" /> New Agent
        </button>
      </div>

      {loading && <Spinner />}
      {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{error}</div>}
      {!loading && !error && !agents.length && <Empty label="No agents found" />}
      {!loading && !error && agents.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agents.map((a: Agent) => (
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
                <div className="flex items-center gap-2">
                  <StatusBadge status={a.status} />
                  <button
                    onClick={() => handleRun(a.id)}
                    className="p-1.5 rounded hover:bg-gray-100"
                    title="Run now"
                  >
                    <Zap className="w-4 h-4 text-gray-600" />
                  </button>
                  <button
                    onClick={() => setEditingAgent(a)}
                    className="p-1.5 rounded hover:bg-gray-100"
                    title="Edit"
                  >
                    <Pencil className="w-4 h-4 text-gray-600" />
                  </button>
                  <button
                    onClick={() => setDeletingAgent(a)}
                    className="p-1.5 rounded hover:bg-red-50"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4 text-red-600" />
                  </button>
                </div>
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

      {(showCreate || editingAgent) && (
        <AgentModal
          agent={editingAgent}
          templates={templates}
          onClose={() => {
            setShowCreate(false);
            setEditingAgent(null);
          }}
          onSave={handleSave}
          loading={modalLoading}
        />
      )}

      {deletingAgent && (
        <DeleteConfirmModal
          itemName={deletingAgent.name}
          onClose={() => setDeletingAgent(null)}
          onConfirm={handleDelete}
          loading={modalLoading}
        />
      )}
    </div>
  );
}

function Spinner() { return <div className="flex justify-center py-16"><span className="w-5 h-5 border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin" /></div>; }
function Empty({ label }: { label: string }) { return <div className="text-center py-16 text-sm" style={{ color: 'var(--muted)' }}>{label}</div>; }

function AgentModal({ agent, templates, onClose, onSave, loading }: {
  agent: Agent | null;
  templates: AgentTemplate[];
  onClose: () => void;
  onSave: (data: Partial<Agent>) => void;
  loading: boolean;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [templateId, setTemplateId] = useState(agent?.templateId ?? agent?.template_id ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !templateId) return;
    onSave({ name: name.trim(), templateId });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" style={{ background: 'var(--card-bg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
            {agent ? 'Edit Agent' : 'New Agent'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text)' }}>Template</label>
            <select
              value={templateId}
              onChange={e => setTemplateId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              required
            >
              <option value="">Select template...</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
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
              disabled={loading || !name.trim() || !templateId}
              className="flex-1 px-4 py-2 rounded-lg text-white disabled:opacity-50"
              style={{ background: 'var(--accent)' }}
            >
              {loading ? 'Saving...' : agent ? 'Save' : 'Create'}
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
