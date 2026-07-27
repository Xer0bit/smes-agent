import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Clock, Plus, Pencil, Trash2, MoreHorizontal, Play, Pause, Archive } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import { ECG } from '../ecg-config';
import StatusBadge from '../components/StatusBadge';
import { PageHeader, Card, EmptyState, Spinner, relTime, AgentDeleteModal } from '../components/ui';

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
  const [nextUpByAgent, setNextUpByAgent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletingAgent, setDeletingAgent] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  useEffect(() => {
    ecgApi.agents.list()
      .then(d => setAgents(Array.isArray(d) ? d : (d.agents ?? [])))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
    // Best-effort "next up" teaser per agent -- so this list reads as what's
    // coming, not just bare status metadata. Non-fatal if it fails.
    ecgApi.posts.list()
      .then((d: any) => {
        const posts = Array.isArray(d) ? d : (d.posts ?? d.plannedPosts ?? []);
        const next: Record<string, string> = {};
        for (const p of posts) {
          if (p.status !== 'draft') continue;
          const agentId = p.agentId ?? p.agent_id;
          if (agentId && !next[agentId]) next[agentId] = p.content ?? p.body ?? '';
        }
        setNextUpByAgent(next);
      })
      .catch(() => {});
  }, []);

  const handleDelete = async () => {
    if (!deletingAgent?.id) return;
    setDeleting(true);
    setDeleteBlocked(false);
    try {
      await ecgApi.agents.delete(deletingAgent.id);
      setAgents(agents.filter(a => a.id !== deletingAgent.id));
      setDeletingAgent(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // Same safety gate the main org portal enforces (org-admin has an
      // Archive action there); this dashboard previously had no way to
      // archive at all, so this exact error was a dead end here.
      if (/only archived agents can be deleted/i.test(msg)) setDeleteBlocked(true);
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

  // Full lifecycle control, matching the main org portal's own Agents page
  // (Activate/Set Idle/Suspend/Archive dropdown). Previously this dashboard
  // only had Delete, which requires status='archived' first -- with no way
  // to archive here, that error was a permanent dead end.
  const handleSetStatus = async (agent: Agent, status: string) => {
    setMenuOpenId(null);
    try {
      await ecgApi.agents.update(agent.id, { status });
      setAgents(agents.map(a => a.id === agent.id ? { ...a, status } : a));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('[data-agent-menu]')) setMenuOpenId(null);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      <PageHeader eyebrow="Content" title="Agents" action={
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/schedulers')} className="text-xs hover:opacity-70" style={{ color: 'var(--muted)' }}>
            Manage all schedules
          </button>
          <button
            onClick={() => navigate('/agents/create')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white hover:opacity-90"
            style={{ background: 'var(--accent)' }}
          >
            <Plus className="w-4 h-4" /> New Agent
          </button>
        </div>
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
                <button onClick={() => navigate(`/agents/${a.id}`)} className="flex items-center gap-3 min-w-0 text-left hover:opacity-80">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-white text-sm"
                    style={{ background: 'var(--accent)', fontWeight: 'var(--font-weight-heading)' }}>
                    {a.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate" style={{ color: 'var(--text)' }}>{a.name}</p>
                    <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{a.templateName ?? a.template_name ?? ' '}</p>
                  </div>
                </button>
                <div className="flex items-center gap-1.5 shrink-0">
                  <StatusBadge status={a.status} />
                  <button onClick={() => handleRun(a.id)} title="Run now" aria-label="Run now"
                    className="p-1.5 rounded hover:bg-[var(--accent-bg)]">
                    <Zap className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                  </button>
                  <button onClick={() => navigate(`/agents/${a.id}/edit`)} title="Edit" aria-label="Edit agent"
                    className="p-1.5 rounded hover:bg-[var(--accent-bg)]">
                    <Pencil className="w-4 h-4" style={{ color: 'var(--muted)' }} />
                  </button>
                  <div className="relative" data-agent-menu>
                    <button onClick={() => setMenuOpenId(menuOpenId === a.id ? null : a.id)} title="Status" aria-label="Change agent status"
                      className="p-1.5 rounded hover:bg-[var(--accent-bg)]">
                      <MoreHorizontal className="w-4 h-4" style={{ color: 'var(--muted)' }} />
                    </button>
                    {menuOpenId === a.id && (
                      <div className="absolute right-0 top-full mt-1 w-40 rounded-lg border overflow-hidden z-20"
                        style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-md)' }}>
                        {a.status !== 'active' && (
                          <button onClick={() => handleSetStatus(a, 'active')}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--accent-bg)]" style={{ color: 'var(--text)' }}>
                            <Play className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} /> Activate
                          </button>
                        )}
                        {a.status === 'active' && (
                          <button onClick={() => handleSetStatus(a, 'idle')}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--accent-bg)]" style={{ color: 'var(--text)' }}>
                            <Pause className="w-3.5 h-3.5" style={{ color: 'var(--muted)' }} /> Set idle
                          </button>
                        )}
                        {a.status !== 'suspended' && (
                          <button onClick={() => handleSetStatus(a, 'suspended')}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--accent-bg)]" style={{ color: '#dc2626' }}>
                            <Pause className="w-3.5 h-3.5" /> Suspend
                          </button>
                        )}
                        {a.status !== 'archived' && (
                          <button onClick={() => handleSetStatus(a, 'archived')}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--accent-bg)]" style={{ color: 'var(--muted)' }}>
                            <Archive className="w-3.5 h-3.5" /> Archive
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <button onClick={() => setDeletingAgent(a)} title="Delete" aria-label="Delete agent"
                    className="p-1.5 rounded hover:bg-red-500/10">
                    <Trash2 className="w-4 h-4" style={{ color: '#dc2626' }} />
                  </button>
                </div>
              </div>
              {nextUpByAgent[a.id] && (
                <p className="mt-3 text-xs truncate" style={{ color: 'var(--text)' }}>
                  <span style={{ color: 'var(--muted)' }}>Next up: </span>{nextUpByAgent[a.id]}
                </p>
              )}
              {showLastRun && (a.lastRun || a.last_run) && (
                <div className="mt-2 flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                  <Clock className="w-3 h-3" />
                  Last run {relTime(a.lastRun ?? a.last_run)}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {deletingAgent && (
        <AgentDeleteModal
          agentName={deletingAgent.name}
          onClose={() => { setDeletingAgent(null); setDeleteBlocked(false); }}
          onConfirm={handleDelete}
          loading={deleting}
          blocked={deleteBlocked}
          onArchiveThenDelete={async () => {
            await handleSetStatus(deletingAgent, 'archived');
            setDeleteBlocked(false);
            handleDelete();
          }}
        />
      )}
    </div>
  );
}
