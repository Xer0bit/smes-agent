import { useEffect, useState } from 'react';
import { Plus, Trash2, X, Play, Pause, Send, Loader2, AlertTriangle } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';
import StatusBadge from '../components/StatusBadge';
import { PageHeader, Card, EmptyState, Spinner, relTime, DAYS_OF_WEEK, buildWeeklyCron, cadenceLabel, platformMeta } from '../components/ui';
import { Calendar } from 'lucide-react';
import { platformsForConnector } from './PostsPage';

const showNextRun = (ECG.moduleSettings.schedulers?.showNextRun ?? true) !== false;

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
      setReplanMsg('Posts are being generated   check Planned Posts in a moment.');
      setTimeout(() => setReplanMsg(''), 5000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTriggeringId(null);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <PageHeader eyebrow="Content" title="Schedulers" action={
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 font-medium text-white hover:opacity-90"
          style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}
        >
          <Plus className="w-4 h-4" /> New Scheduler
        </button>
      } />

      {error && <div className="px-4 py-3" style={{ fontSize: 'var(--text-small)', color: 'var(--danger)', background: 'var(--danger-bg)', borderRadius: 'var(--radius)' }}>{error}</div>}
      {replanMsg && <div className="px-4 py-3" style={{ fontSize: 'var(--text-small)', background: 'var(--accent-bg)', color: 'var(--text)', borderRadius: 'var(--radius)' }}>{replanMsg}</div>}

      {loading && <Spinner />}
      {!loading && !rows.length && (
        <EmptyState Icon={Calendar} title="No schedulers configured"
          hint="A scheduler tells an agent when to generate and publish posts. Create one to put your content on autopilot." />
      )}
      {!loading && rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full" style={{ minWidth: '640px', fontSize: 'var(--text-small)' }}>
            <thead>
              <tr className="border-b" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                {['Agent', 'Schedule', ...(showNextRun ? ['Next Run'] : []), 'Status', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-semibold uppercase" style={{ fontSize: 'var(--text-tiny)', letterSpacing: 'var(--tracking-wide)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {rows.map((s: any) => (
                <tr key={s.id} className="ecg-row-hover">
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--text)' }}>{s.agentName ?? s.agent_name ?? ' '}</td>
                  <td className="px-4 py-3" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
                    {cadenceLabel(s.schedule ?? s.cron, s.postCount ?? s.post_count)}
                  </td>
                  {showNextRun && (
                    <td className="px-4 py-3" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}
                      title={s.nextRun ? new Date(s.nextRun).toLocaleString() : undefined}>
                      {s.nextRun ? relTime(s.nextRun) : ' '}
                    </td>
                  )}
                  <td className="px-4 py-3"><StatusBadge status={s.status ?? 'active'} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleTrigger(s.id)}
                        disabled={triggeringId === s.id}
                        title="Generate posts now" aria-label="Generate posts now"
                        className="flex items-center justify-center w-8 h-8 hover:bg-[var(--accent-bg)] disabled:opacity-50 transition-colors"
                        style={{ borderRadius: 'var(--radius-sm)' }}
                      >
                        {triggeringId === s.id
                          ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--muted)' }} />
                          : <Send className="w-4 h-4" style={{ color: 'var(--accent)' }} />}
                      </button>
                      <button
                        onClick={() => handleToggle(s.id, s.status)}
                        title={s.status === 'active' ? 'Pause schedule' : 'Resume schedule'}
                        aria-label={s.status === 'active' ? 'Pause schedule' : 'Resume schedule'}
                        className="flex items-center justify-center w-8 h-8 hover:bg-[var(--accent-bg)] transition-colors"
                        style={{ borderRadius: 'var(--radius-sm)' }}
                      >
                        {s.status === 'active'
                          ? <Pause className="w-4 h-4" style={{ color: 'var(--muted)' }} />
                          : <Play className="w-4 h-4" style={{ color: 'var(--muted)' }} />}
                      </button>
                      <span className="w-px h-5 mx-0.5" style={{ background: 'var(--border)' }} />
                      <button
                        onClick={() => setDeletingScheduler(s)}
                        title="Delete schedule" aria-label="Delete schedule"
                        className="flex items-center justify-center w-8 h-8 hover:bg-red-500/10 transition-colors"
                        style={{ borderRadius: 'var(--radius-sm)' }}
                      >
                        <Trash2 className="w-4 h-4" style={{ color: 'var(--danger)' }} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
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

  const selectedConnector = connectors.find(c => c.id === connectorId);
  const connectorType = selectedConnector?.type ?? '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agentId || !connectorId || !connectorType || daysOfWeek.length === 0) {
      setError('Agent, connector, and at least one day are required.');
      return;
    }
    setCreating(true);
    setError('');
    try {
      // platforms must be passed explicitly -- create_scheduler defaults it to
      // ['linkedin'] when omitted, so a generic multi-platform connector
      // covering e.g. only Facebook+YouTube would otherwise silently get
      // scheduled to post to LinkedIn instead.
      const platforms = selectedConnector ? platformsForConnector(selectedConnector) : [];
      const created = await ecgApi.schedulers.create({
        agentId,
        connector: connectorType,
        platforms: platforms.length > 0 ? platforms : undefined,
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
      <div className="w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto" style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)' }}>
        <div className="flex items-center justify-between">
          <h2 style={{ fontSize: 'var(--text-lg)', color: 'var(--text)' }}>New Scheduler</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--accent-bg)]">
            <X className="w-5 h-5" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>Agent</label>
            <select value={agentId} onChange={e => setAgentId(e.target.value)}
              className="w-full px-3 py-2 border focus:outline-none" style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }} required>
              <option value="">Select agent...</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>

          <div>
            <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>Connector</label>
            {connectors.length === 0 ? (
              <p className="flex items-center gap-1.5" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> No connected accounts   connect one in Connectors first.
              </p>
            ) : (
              <select value={connectorId} onChange={e => setConnectorId(e.target.value)}
                className="w-full px-3 py-2 border focus:outline-none" style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }} required>
                <option value="">Select connector...</option>
                {connectors.map(c => {
                  const platforms = platformsForConnector(c);
                  const label = platforms.length > 0 ? platforms.map(p => platformMeta(p).label).join(', ') : 'unmapped';
                  return <option key={c.id} value={c.id}>{c.name} ({label})</option>;
                })}
              </select>
            )}
          </div>

          <div>
            <p className="font-medium mb-1.5" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Days of week</p>
            <div className="flex flex-wrap gap-1.5">
              {DAYS_OF_WEEK.map(d => {
                const on = daysOfWeek.includes(d.value);
                return (
                  <button key={d.value} type="button"
                    onClick={() => setDaysOfWeek(prev => on ? prev.filter(v => v !== d.value) : [...prev, d.value])}
                    className="px-3 py-1.5 rounded-lg border transition-colors"
                    style={on ? { fontSize: 'var(--text-tiny)', background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : { fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', color: 'var(--text)' }}>
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block font-medium mb-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Earliest post time</label>
            <select value={startHour} onChange={e => setStartHour(Number(e.target.value))}
              className="w-full px-3 py-2 border focus:outline-none" style={{ fontSize: 'var(--text-small)', background: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-medium" style={{ fontSize: 'var(--text-tiny)', color: 'var(--text)' }}>Posts per run</label>
              <span className="font-mono" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>{postCount}</span>
            </div>
            <input type="range" min={1} max={10} value={postCount} onChange={e => setPostCount(Number(e.target.value))} className="w-full" />
          </div>

          {error && <p className="px-3 py-2" style={{ fontSize: 'var(--text-small)', color: 'var(--danger)', background: 'var(--danger-bg)', borderRadius: 'var(--radius-sm)' }}>{error}</p>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border" style={{ fontSize: 'var(--text-small)', borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>Cancel</button>
            <button type="submit" disabled={creating}
              className="flex-1 px-4 py-2 text-white hover:opacity-90 disabled:opacity-50" style={{ fontSize: 'var(--text-small)', background: 'var(--accent)', borderRadius: 'var(--radius-sm)' }}>
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
      <div className="w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--card-bg)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)' }}>
        <h2 style={{ fontSize: 'var(--text-lg)', color: 'var(--text)' }}>Delete Scheduler</h2>
        <p style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>
          Are you sure you want to delete <strong>{itemName}</strong>? This action cannot be undone.
        </p>
        <div className="flex gap-3 pt-2">
          <button onClick={onClose} disabled={loading} className="flex-1 px-4 py-2 border" style={{ borderColor: 'var(--border)', color: 'var(--text)', borderRadius: 'var(--radius-sm)' }}>Cancel</button>
          <button onClick={onConfirm} disabled={loading} className="flex-1 px-4 py-2 text-white hover:opacity-90 disabled:opacity-50" style={{ background: 'var(--danger)', borderRadius: 'var(--radius-sm)' }}>
            {loading ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
