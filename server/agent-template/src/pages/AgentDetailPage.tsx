import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Zap, Pencil, FileText, Play, Pause, MoreHorizontal, Archive } from 'lucide-react';
import { ecgApi } from '../lib/ecgClient';
import StatusBadge from '../components/StatusBadge';
import { Card, Spinner, EmptyState, SectionHeader, relTime, cadenceLabel } from '../components/ui';

interface AgentDetail {
  agent: { id: string; name: string; status: string; lastRunAt: string | null };
  recentRuns: Array<{ id: string; status: string; startedAt: string; durationMs: number; cost: number; tokensIn: number; tokensOut: number }>;
  schedulers: Array<{ id: string; cron: string; status: string; nextRun: string | null; lastRun: string | null; postCount: number }>;
}

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    ecgApi.agents.get(agentId)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  const handleRun = async () => {
    if (!agentId) return;
    setRunning(true);
    try {
      await ecgApi.agents.run(agentId);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  // Full lifecycle control, matching the main org portal's own Agents page
  // (Activate/Set Idle/Suspend/Archive). Deleting requires 'archived' first
  // -- do that from the Agents list, where Delete lives.
  const handleSetStatus = async (status: string) => {
    if (!agentId || !data) return;
    setMenuOpen(false);
    try {
      await ecgApi.agents.update(agentId, { status });
      setData({ ...data, agent: { ...data.agent, status } });
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading) return <div className="p-6"><Spinner /></div>;

  if (error || !data) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <button onClick={() => navigate('/agents')} className="flex items-center gap-1.5 mb-4 hover:opacity-70" style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Agents
        </button>
        <div className="px-4 py-3" style={{ fontSize: 'var(--text-small)', color: 'var(--danger)', background: 'var(--danger-bg)', borderRadius: 'var(--radius)' }}>
          {error || 'Agent not found'}
        </div>
      </div>
    );
  }

  const { agent, recentRuns, schedulers } = data;

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <button onClick={() => navigate('/agents')} className="flex items-center gap-1.5 hover:opacity-70" style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Agents
      </button>

      {/* Identity header: avatar/name/status inline, actions on the right --
          the Detail/Editor page-type template (design.md). */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 flex items-center justify-center shrink-0 text-white"
            style={{ background: 'var(--accent-gradient)', fontWeight: 'var(--font-weight-heading)', fontSize: 'var(--text-lg)', borderRadius: 'var(--radius)' }}>
            {agent.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h2 className="truncate" style={{ color: 'var(--text)', fontSize: 'var(--text-h2)' }}>{agent.name}</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <StatusBadge status={agent.status} />
              {agent.lastRunAt && (
                <span style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>Last run {relTime(agent.lastRunAt)}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <button onClick={() => setMenuOpen(v => !v)}
              className="flex items-center gap-1.5 px-3 py-2 font-medium border"
              style={{ borderColor: 'var(--border)', color: 'var(--text)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}>
              <MoreHorizontal className="w-3.5 h-3.5" /> Status
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-40 border overflow-hidden z-20"
                style={{ background: 'var(--card-bg)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-md)', borderRadius: 'var(--radius-sm)' }}>
                {agent.status !== 'active' && (
                  <button onClick={() => handleSetStatus('active')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--accent-bg)]" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>
                    <Play className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} /> Activate
                  </button>
                )}
                {agent.status === 'active' && (
                  <button onClick={() => handleSetStatus('idle')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--accent-bg)]" style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>
                    <Pause className="w-3.5 h-3.5" style={{ color: 'var(--muted)' }} /> Set idle
                  </button>
                )}
                {agent.status !== 'suspended' && (
                  <button onClick={() => handleSetStatus('suspended')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--accent-bg)]" style={{ fontSize: 'var(--text-small)', color: 'var(--danger)' }}>
                    <Pause className="w-3.5 h-3.5" /> Suspend
                  </button>
                )}
                {agent.status !== 'archived' && (
                  <button onClick={() => handleSetStatus('archived')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--accent-bg)]" style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>
                    <Archive className="w-3.5 h-3.5" /> Archive
                  </button>
                )}
              </div>
            )}
          </div>
          <button onClick={handleRun} disabled={running}
            className="flex items-center gap-1.5 px-3 py-2 font-medium text-white hover:opacity-90 disabled:opacity-50"
            style={{ background: 'var(--accent)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}>
            <Zap className="w-3.5 h-3.5" /> {running ? 'Running…' : 'Run now'}
          </button>
          <button onClick={() => navigate(`/agents/${agent.id}/edit`)}
            className="flex items-center gap-1.5 px-3 py-2 font-medium border"
            style={{ borderColor: 'var(--border)', color: 'var(--text)', fontSize: 'var(--text-small)', borderRadius: 'var(--radius)' }}>
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <SectionHeader title="Schedulers" action={
            <button onClick={() => navigate('/schedulers')} className="hover:opacity-70" style={{ fontSize: 'var(--text-tiny)', color: 'var(--accent)' }}>
              Manage
            </button>
          } />
          {schedulers.length === 0 ? (
            <p className="py-2" style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>No scheduler set up for this agent yet.</p>
          ) : (
            <div className="space-y-2">
              {schedulers.map(s => (
                <div key={s.id} className="flex items-center justify-between border px-3 py-2" style={{ borderColor: 'var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <div>
                    <p style={{ fontSize: 'var(--text-small)', color: 'var(--text)' }}>{cadenceLabel(s.cron, s.postCount)}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <StatusBadge status={s.status} />
                    {s.nextRun && <p className="mt-1" style={{ fontSize: 'var(--text-tiny)', color: 'var(--muted)' }}>next {relTime(s.nextRun)}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <SectionHeader title="Recent runs" action={
            <button onClick={() => navigate('/runs')} className="hover:opacity-70" style={{ fontSize: 'var(--text-tiny)', color: 'var(--accent)' }}>
              View all
            </button>
          } />
          {recentRuns.length === 0 ? (
            <p className="py-2" style={{ fontSize: 'var(--text-small)', color: 'var(--muted)' }}>No runs yet.</p>
          ) : (
            <div className="space-y-2">
              {recentRuns.map(r => (
                <div key={r.id} className="flex items-center justify-between border px-3 py-2" style={{ fontSize: 'var(--text-tiny)', borderColor: 'var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <StatusBadge status={r.status} />
                  <span style={{ color: 'var(--muted)' }}>{(r.durationMs / 1000).toFixed(1)}s</span>
                  <span style={{ color: 'var(--muted)' }}>${Number(r.cost).toFixed(3)}</span>
                  <span style={{ color: 'var(--muted)' }}>{relTime(r.startedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {schedulers.length === 0 && recentRuns.length === 0 && (
        <EmptyState Icon={FileText} title="Nothing here yet"
          hint="Run this agent or set up a scheduler to start seeing activity." />
      )}
    </div>
  );
}
